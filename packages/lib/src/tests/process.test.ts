/**
 * Process liveness: the EPERM-means-alive rule, and the procfs start-time read degrading
 * cleanly where there is no procfs.
 */
import { describe, it, expect } from 'bun:test';
import { isProcessAlive, readProcessStartTime } from '../process.js';

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a pid unlikely to exist', () => {
    // Not a guarantee on every machine, but 2**30 is well past any real pid space.
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });

  it('rejects non-positive or non-integer input without signaling anything', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe('readProcessStartTime', () => {
  it('reads a value for the current process on Linux, or null where there is no procfs', () => {
    const start = readProcessStartTime(process.pid);
    if (process.platform === 'linux') {
      expect(start).not.toBeNull();
      expect(start).toMatch(/^\d+$/);
    } else {
      expect(start).toBeNull();
    }
  });

  it('is null for a pid that does not exist', () => {
    expect(readProcessStartTime(2 ** 30)).toBeNull();
  });

  it('is stable across repeated reads of the same live process', () => {
    if (process.platform !== 'linux') return;
    expect(readProcessStartTime(process.pid)).toBe(readProcessStartTime(process.pid));
  });
});
