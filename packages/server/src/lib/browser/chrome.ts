/**
 * Chrome binary finder and launcher.
 *
 * Locates Chrome/Edge on the system and launches it in headless mode
 * with remote debugging enabled. No external dependencies required —
 * works anywhere Chrome is installed (including Windows .exe builds).
 */

import { existsSync } from 'fs';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

/** PID file to track Chrome process across server restarts / crashes. */
const PID_FILE = join(tmpdir(), 'yaar-browser.pid');

interface PidRecord {
  pid: number;
  userDataDir: string;
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

  await removePidFile();
}

// ── PID file helpers ──────────────────────────────────────────────────

/** Write PID record so a future server restart can find and kill an orphan. */
export async function writePidFile(instance: ChromeInstance): Promise<void> {
  try {
    const record: PidRecord = { pid: instance.process.pid, userDataDir: instance.userDataDir };
    await writeFile(PID_FILE, JSON.stringify(record));
  } catch {
    /* non-critical — stale cleanup on next restart just won't find this run */
  }
}

/** Remove the PID file (called on clean shutdown). */
export async function removePidFile(): Promise<void> {
  try {
    await rm(PID_FILE, { force: true });
  } catch {
    /* non-critical */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up stale Chrome processes and temp dirs from previous crashed runs.
 * Called once before launching a new Chrome instance.
 *
 * Handles two scenarios:
 * 1. PID file exists → kill the orphaned Chrome process
 * 2. /tmp/yaar-browser-* dirs exist → remove them (all are stale since we haven't launched yet)
 */
export async function cleanupStaleChrome(): Promise<void> {
  let killedPid = false;

  // 1. Check PID file for an orphaned Chrome process
  try {
    const data = await readFile(PID_FILE, 'utf-8');
    const record: PidRecord = JSON.parse(data);
    if (record.pid && isProcessAlive(record.pid)) {
      console.log(`[browser] Killing stale Chrome process (PID ${record.pid})`);
      try {
        process.kill(record.pid, 'SIGKILL');
        killedPid = true;
      } catch {
        /* process died between check and kill — fine */
      }
    }
  } catch {
    /* no PID file or invalid JSON — continue */
  }

  // Give killed process time to release resources (ports, file locks)
  if (killedPid) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. Remove all stale yaar-browser-* temp directories
  try {
    const tmp = tmpdir();
    const entries = await readdir(tmp);
    for (const entry of entries) {
      if (entry.startsWith('yaar-browser-')) {
        const fullPath = join(tmp, entry);
        await rm(fullPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    /* /tmp scan failure is non-critical */
  }

  // 3. Remove stale PID file
  await removePidFile();
}
