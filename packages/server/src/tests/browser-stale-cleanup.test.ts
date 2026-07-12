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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('stale Chrome cleanup', () => {
  // Clean up test artifacts
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'yaar-browser-cleanup-test-'));
    pidFile = join(testDir, 'yaar-browser.pid');
  });
  afterEach(async () => {
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
    it('removes stale yaar-browser-* temp dirs', async () => {
      // Create a fake stale temp dir
      const staleDir = join(testDir, 'yaar-browser-staletest');
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, 'marker.txt'), 'stale');

      expect(await fileExists(staleDir)).toBe(true);

      await cleanupStaleChrome({ pidFile, tempDir: testDir });

      expect(await fileExists(staleDir)).toBe(false);
    });

    it('removes stale PID file even when PID is dead', async () => {
      // Write a PID file with a PID that's almost certainly not alive
      await writeFile(pidFile, JSON.stringify({ pid: 999999999, userDataDir: '/tmp/nope' }));

      await cleanupStaleChrome({ pidFile, tempDir: testDir });

      expect(await fileExists(pidFile)).toBe(false);
    });

    it('handles missing PID file gracefully', async () => {
      // No PID file, no temp dirs — should just succeed
      await cleanupStaleChrome({ pidFile, tempDir: testDir });
    });

    it('handles malformed PID file gracefully', async () => {
      await writeFile(pidFile, 'not valid json!!!');

      // Should not throw
      await cleanupStaleChrome({ pidFile, tempDir: testDir });

      // PID file should be cleaned up
      expect(await fileExists(pidFile)).toBe(false);
    });
  });
});
