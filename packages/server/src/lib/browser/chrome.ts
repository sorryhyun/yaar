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

  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
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

    // Read stderr as a stream to find the DevTools URL
    const reader = proc.stderr.getReader();
    let stderrData = '';

    const readChunk = () => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            clearTimeout(timeout);
            reject(new Error(`Chrome stderr ended. stderr: ${stderrData.slice(0, 500)}`));
            return;
          }
          stderrData += new TextDecoder().decode(value);
          const match = stderrData.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            reader.releaseLock();
            resolve(match[1]);
          } else {
            readChunk();
          }
        })
        .catch((err: unknown) => {
          clearTimeout(timeout);
          reject(err);
        });
    };
    readChunk();

    // Also handle early exit
    proc.exited.then((code: number) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited with code ${code}. stderr: ${stderrData.slice(0, 500)}`));
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
}
