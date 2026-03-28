/**
 * Chrome binary finder and launcher.
 *
 * Locates Chrome/Edge on the system and launches it in headless mode
 * with remote debugging enabled. No external dependencies required —
 * works anywhere Chrome is installed (including Windows .exe builds).
 */

import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

import { createServer } from 'net';

import { writePidFile, removePidFile, cleanupStaleChrome } from './pid-file.js';
export { writePidFile, removePidFile, cleanupStaleChrome };

/** Find a free TCP port by briefly binding to port 0. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Poll Chrome's DevTools HTTP endpoint until we get the browser WS URL.
 * Used on Windows where Chrome forks and the parent process exits immediately.
 */
async function pollDevToolsEndpoint(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevTools endpoint not available on port ${port} after ${timeoutMs}ms`);
}

const CHROME_PATHS: Record<string, string[]> = {
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // WSL: Windows Chrome via /mnt/c/
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  win32: [
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES'] || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env['PROGRAMFILES'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

const WHICH_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

/**
 * Find a Chrome or Edge binary on the system.
 * Checks CHROME_PATH env var first, then platform-specific known paths.
 */
export async function findChrome(): Promise<string | null> {
  // Env var takes priority
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // Check platform-specific paths
  const candidates = CHROME_PATHS[process.platform] || [];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }

  // Try which/where for PATH-based candidates (Linux/macOS)
  if (process.platform !== 'win32') {
    for (const cmd of WHICH_CANDIDATES) {
      try {
        const result = Bun.spawnSync(['which', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
        const path = result.stdout.toString().trim();
        if (result.exitCode === 0 && path) return path;
      } catch {
        // Not found
      }
    }
  }

  return null;
}

export interface ChromeInstance {
  process: Subprocess;
  port: number;
  wsUrl: string;
  userDataDir: string;
}

/**
 * Launch Chrome in headless mode with remote debugging.
 * Returns connection info once DevTools is ready.
 */
export async function launchChrome(chromePath: string): Promise<ChromeInstance> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'yaar-browser-'));

  // Use a fixed debugging port on Windows: Chrome on Windows may fork a child process
  // and exit the parent immediately (code 0) without printing the DevTools URL. With a
  // known port we can poll for the endpoint instead of relying solely on stderr parsing.
  const debugPort = process.platform === 'win32' ? await findFreePort() : 0;

  const args = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-extensions',
    '--disable-component-update',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    'about:blank',
  ];

  const proc = Bun.spawn([chromePath, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Parse the DevTools WebSocket URL from stderr
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Chrome launch timeout (10s)'));
    }, 10_000);

    let resolved = false;

    // Read stderr as a stream to find the DevTools URL
    const reader = proc.stderr.getReader();
    let stderrData = '';

    // On Windows, Chrome may not write the DevTools URL to stderr at all
    // (e.g. in Git Bash / MSYS2 environments). Fall back to HTTP polling.
    const tryPollFallback = async (reason: string) => {
      if (resolved) return;
      if (debugPort > 0) {
        try {
          const ws = await pollDevToolsEndpoint(debugPort, 5000);
          resolved = true;
          clearTimeout(timeout);
          resolve(ws);
        } catch {
          clearTimeout(timeout);
          reject(new Error(`${reason} Polling port ${debugPort} also failed.`));
        }
      } else {
        clearTimeout(timeout);
        reject(new Error(reason));
      }
    };

    const readChunk = () => {
      reader
        .read()
        .then(({ done, value }) => {
          if (resolved) return;
          if (done) {
            // stderr closed — on Windows, try polling the known debug port
            tryPollFallback(`Chrome stderr ended. stderr: ${stderrData.slice(0, 500)}`);
            return;
          }
          stderrData += new TextDecoder().decode(value);
          const match = stderrData.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            resolved = true;
            clearTimeout(timeout);
            reader.releaseLock();
            resolve(match[1]);
          } else {
            readChunk();
          }
        })
        .catch((err: unknown) => {
          if (resolved) return;
          clearTimeout(timeout);
          reject(err);
        });
    };
    readChunk();

    // Handle early exit — on Windows, Chrome may fork and the parent exits with code 0.
    proc.exited.then(async (code: number) => {
      if (resolved) return;
      tryPollFallback(`Chrome exited with code ${code}. stderr: ${stderrData.slice(0, 500)}`);
    });
  });

  const portMatch = wsUrl.match(/:(\d+)\//);
  const port = portMatch ? parseInt(portMatch[1], 10) : 0;

  return { process: proc, port, wsUrl, userDataDir };
}

/**
 * Kill Chrome process and clean up temp profile directory.
 */
export async function cleanupChrome(instance: ChromeInstance): Promise<void> {
  // On Windows, Chrome may have forked — the process handle might be the dead parent.
  // Send Browser.close via CDP to ensure the actual Chrome child shuts down.
  if (instance.port > 0) {
    try {
      const resp = await fetch(`http://127.0.0.1:${instance.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) {
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise<void>((resolve) => {
          ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            setTimeout(() => {
              ws.close();
              resolve();
            }, 500);
          };
          ws.onerror = () => resolve();
          setTimeout(resolve, 2000);
        });
      }
    } catch {
      /* CDP close failed — fall through to process kill */
    }
  }

  try {
    instance.process.kill();
  } catch {
    /* already dead */
  }

  // Wait for process to exit
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    await rm(instance.userDataDir, { recursive: true, force: true });
  } catch {
    /* cleanup failure is non-critical */
  }

  await removePidFile();
}
