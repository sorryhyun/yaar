/**
 * Tests for stale Chrome cleanup — PID file tracking, orphan detection,
 * and temp directory removal.
 *
 * These test the actual (unmocked) functions from chrome.ts to verify
 * the cleanup logic works end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, readFile, mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { cleanupStaleChrome, writePidFile, removePidFile } from '../lib/browser/pid-file.js';

let testDir: string;
let pidFile: string;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const children: Subprocess[] = [];

/** A harmless long-lived process carrying `args` on its command line. */
function spawnIdler(args: string[]): Subprocess {
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60000)', '--', ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  children.push(child);
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A PID no process holds (larger than any pid_max). */
const DEAD_PID = 999999999;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('stale Chrome cleanup', () => {
  // Clean up test artifacts
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'yaar-browser-cleanup-test-'));
    pidFile = join(testDir, 'yaar-browser.pid');
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('writePidFile / removePidFile', () => {
    it('writes a valid JSON PID file', async () => {
      const fakeInstance = {
        process: { pid: 12345 },
        port: 9222,
        wsUrl: 'ws://localhost:9222/devtools/browser/abc',
        userDataDir: '/tmp/yaar-browser-test123',
      };

      await writePidFile(fakeInstance as never, pidFile);

      const data = JSON.parse(await readFile(pidFile, 'utf-8'));
      expect(data.pid).toBe(12345);
      expect(data.userDataDir).toBe('/tmp/yaar-browser-test123');
      // Whose Chrome it is — what lets a second instance leave it alone.
      expect(data.ownerPid).toBe(process.pid);
    });

    it('removePidFile deletes the file', async () => {
      await writeFile(pidFile, '{}');
      expect(await fileExists(pidFile)).toBe(true);

      await removePidFile(pidFile);
      expect(await fileExists(pidFile)).toBe(false);
    });

    it('removePidFile is a no-op when no file exists', async () => {
      // Should not throw
      await removePidFile(pidFile);
    });
  });

  describe('cleanupStaleChrome', () => {
    it('removes yaar-browser-* temp dirs whose owning server is gone', async () => {
      // Owned by a server PID that is not running.
      const staleDir = join(testDir, `yaar-browser-${DEAD_PID}-staletest`);
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, 'marker.txt'), 'stale');

      expect(await fileExists(staleDir)).toBe(true);

      await cleanupStaleChrome({ tempDir: testDir });

      expect(await fileExists(staleDir)).toBe(false);
    });

    it('removes stale PID file even when PID is dead', async () => {
      // Write a PID file with a PID that's almost certainly not alive
      await writeFile(pidFile, JSON.stringify({ pid: 999999999, userDataDir: '/tmp/nope' }));

      await cleanupStaleChrome({ tempDir: testDir });

      expect(await fileExists(pidFile)).toBe(false);
    });

    it('leaves a live PID alone when it is not the recorded Chrome', async () => {
      // A recycled PID: alive, but its command line names no profile of ours.
      const child = spawnIdler([]);
      const userDataDir = join(testDir, 'profile');
      await writeFile(pidFile, JSON.stringify({ pid: child.pid, userDataDir }));

      await cleanupStaleChrome({ tempDir: testDir });

      expect(isAlive(child.pid)).toBe(true);
      expect(await fileExists(pidFile)).toBe(false);
    });

    it('kills a live PID whose command line names the recorded profile', async () => {
      const userDataDir = join(testDir, 'profile');
      const child = spawnIdler([`--user-data-dir=${userDataDir}`]);
      await writeFile(pidFile, JSON.stringify({ pid: child.pid, userDataDir }));

      await cleanupStaleChrome({ tempDir: testDir });

      await child.exited;
      expect(isAlive(child.pid)).toBe(false);
    });

    // Two YAARs on one machine (bugs.md #3). Each one's first sandbox launch used to
    // kill the other's Chrome and wipe its scratch profile and download captures.
    it("leaves a live instance's Chrome, PID file and scratch dirs alone", async () => {
      const otherServer = spawnIdler([]);
      const profile = join(testDir, `yaar-browser-${otherServer.pid}-prof`);
      const downloads = join(testDir, `yaar-browser-dl-${otherServer.pid}-abc`);
      await mkdir(profile);
      await mkdir(downloads);
      const chrome = spawnIdler([`--user-data-dir=${profile}`]);
      const theirPidFile = join(testDir, `yaar-browser-${otherServer.pid}.pid`);
      await writeFile(
        theirPidFile,
        JSON.stringify({ pid: chrome.pid, userDataDir: profile, ownerPid: otherServer.pid }),
      );

      await cleanupStaleChrome({ tempDir: testDir });

      expect(isAlive(chrome.pid)).toBe(true);
      expect(await fileExists(theirPidFile)).toBe(true);
      expect(await fileExists(profile)).toBe(true);
      expect(await fileExists(downloads)).toBe(true);
    });

    it("reaps a dead instance's orphaned Chrome and its scratch dirs", async () => {
      const profile = join(testDir, `yaar-browser-${DEAD_PID}-prof`);
      const downloads = join(testDir, `yaar-browser-dl-${DEAD_PID}-abc`);
      await mkdir(profile);
      await mkdir(downloads);
      const orphan = spawnIdler([`--user-data-dir=${profile}`]);
      const orphanPidFile = join(testDir, `yaar-browser-${DEAD_PID}.pid`);
      await writeFile(
        orphanPidFile,
        JSON.stringify({ pid: orphan.pid, userDataDir: profile, ownerPid: DEAD_PID }),
      );

      await cleanupStaleChrome({ tempDir: testDir });

      await orphan.exited;
      expect(isAlive(orphan.pid)).toBe(false);
      expect(await fileExists(orphanPidFile)).toBe(false);
      expect(await fileExists(profile)).toBe(false);
      expect(await fileExists(downloads)).toBe(false);
    });

    it("keeps this server's own scratch dirs — a relaunch runs while its sessions live", async () => {
      // A download capture of a session that is about to be reattached to the new Chrome.
      const ours = join(testDir, `yaar-browser-dl-${process.pid}-abc`);
      await mkdir(ours);

      await cleanupStaleChrome({ tempDir: testDir });

      expect(await fileExists(ours)).toBe(true);
    });

    it("kills this server's own previous Chrome before it launches the next", async () => {
      const profile = join(testDir, 'profile');
      const previous = spawnIdler([`--user-data-dir=${profile}`]);
      await writePidFile(
        { process: { pid: previous.pid }, userDataDir: profile },
        join(testDir, `yaar-browser-${process.pid}.pid`),
      );

      await cleanupStaleChrome({ tempDir: testDir });

      await previous.exited;
      expect(isAlive(previous.pid)).toBe(false);
    });

    it('handles missing PID file gracefully', async () => {
      // No PID file, no temp dirs — should just succeed
      await cleanupStaleChrome({ tempDir: testDir });
    });

    it('handles malformed PID file gracefully', async () => {
      await writeFile(pidFile, 'not valid json!!!');

      // Should not throw
      await cleanupStaleChrome({ tempDir: testDir });

      // PID file should be cleaned up
      expect(await fileExists(pidFile)).toBe(false);
    });
  });
});
