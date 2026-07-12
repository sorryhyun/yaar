/**
 * PID file tracking and stale Chrome cleanup.
 *
 * Separated from chrome.ts so that tests can import these functions
 * without being affected by mock.module() applied to chrome.js in
 * other test files (Bun shares the mock registry across test files).
 */

import { rm, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

interface PidRecord {
  pid: number;
  userDataDir: string;
}

/** PID file to track Chrome process across server restarts / crashes. */
const PID_FILE = join(tmpdir(), 'yaar-browser.pid');

interface CleanupOptions {
  pidFile?: string;
  tempDir?: string;
}

/** Write PID record so a future server restart can find and kill an orphan. */
export async function writePidFile(
  instance: {
    process: { pid: number };
    userDataDir: string;
  },
  pidFile = PID_FILE,
): Promise<void> {
  try {
    const record: PidRecord = { pid: instance.process.pid, userDataDir: instance.userDataDir };
    await writeFile(pidFile, JSON.stringify(record));
  } catch {
    /* non-critical — stale cleanup on next restart just won't find this run */
  }
}

/** Remove the PID file (called on clean shutdown). */
export async function removePidFile(pidFile = PID_FILE): Promise<void> {
  try {
    await rm(pidFile, { force: true });
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
export async function cleanupStaleChrome(options: CleanupOptions = {}): Promise<void> {
  const pidFile = options.pidFile ?? PID_FILE;
  const tempDir = options.tempDir ?? tmpdir();
  let killedPid = false;

  // 1. Check PID file for an orphaned Chrome process
  try {
    const data = await readFile(pidFile, 'utf-8');
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
    const entries = await readdir(tempDir);
    for (const entry of entries) {
      if (entry.startsWith('yaar-browser-')) {
        const fullPath = join(tempDir, entry);
        await rm(fullPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    /* /tmp scan failure is non-critical */
  }

  // 3. Remove stale PID file
  await removePidFile(pidFile);
}
