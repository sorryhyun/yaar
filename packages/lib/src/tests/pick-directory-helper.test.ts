/**
 * The folder-dialog helper protocol, driven by fake helpers: one JSON line decides the answer,
 * a cancel or the deadline is an answer (null), and anything else — an error line, no line, a
 * crash, a helper that cannot start — is `undefined`, which sends `pickDirectory` to its fallback.
 */
import { describe, it, expect } from 'bun:test';
import { tryFileDialog } from '../pick-directory.js';

const helper = (code: string) => [process.execPath, '-e', code];

describe('tryFileDialog', () => {
  it('returns the path the helper reports', async () => {
    const path = 'C:\\Users\\someone\\한글 폴더';
    const argv = helper(`console.log(JSON.stringify({ path: ${JSON.stringify(path)} }))`);
    expect(await tryFileDialog(argv, 10_000)).toBe(path);
  });

  it('treats a cancel as an answer', async () => {
    expect(
      await tryFileDialog(helper('console.log(JSON.stringify({ cancelled: true }))'), 10_000),
    ).toBeNull();
  });

  it('kills a helper that outlives the deadline and answers null', async () => {
    const started = Date.now();
    expect(await tryFileDialog(helper('setTimeout(() => {}, 30000)'), 500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('falls back on an error line, on no line, and on a crash', async () => {
    expect(
      await tryFileDialog(
        helper('console.log(JSON.stringify({ error: "Show 0x80004005" }))'),
        10_000,
      ),
    ).toBeUndefined();
    expect(await tryFileDialog(helper(''), 10_000)).toBeUndefined();
    expect(await tryFileDialog(helper('process.exit(3)'), 10_000)).toBeUndefined();
  });

  it('falls back when the helper cannot start', async () => {
    expect(await tryFileDialog(['/nonexistent/yaar-helper-binary'], 10_000)).toBeUndefined();
  });
});
