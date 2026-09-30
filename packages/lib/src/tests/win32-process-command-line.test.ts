/**
 * `readProcessCommandLine`: on Windows it reads a live child's full command line (spaces,
 * non-ASCII, longer than the first 4 KiB buffer); everywhere else it throws, so a caller's
 * fallback takes over.
 */
import { describe, it, expect } from 'bun:test';
import { readProcessCommandLine } from '../win32/index.js';

describe('readProcessCommandLine', () => {
  if (process.platform !== 'win32') {
    it('throws off Windows', () => {
      expect(() => readProcessCommandLine(process.pid)).toThrow();
    });
    return;
  }

  it('reads a child command line with spaces, non-ASCII, and more than 4 KiB', async () => {
    const flag = '--user-data-dir=C:\\yaar test\\한글 폴더';
    const padding = '--pad=' + 'x'.repeat(5000);
    const child = Bun.spawn(
      [process.execPath, '-e', 'setTimeout(() => {}, 10000)', flag, padding],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    try {
      const commandLine = readProcessCommandLine(child.pid);
      expect(commandLine).toContain(flag);
      expect(commandLine).toContain(padding);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it('reads the current process', () => {
    expect(readProcessCommandLine(process.pid)).toContain('bun');
  });

  it('is null for a pid that does not exist', () => {
    expect(readProcessCommandLine(2 ** 30)).toBeNull();
  });
});
