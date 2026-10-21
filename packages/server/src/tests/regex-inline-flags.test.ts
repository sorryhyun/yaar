/**
 * A leading PCRE-style flag group in a search pattern, at the server's search sites.
 *
 * Agents write `(?i)foo` — the ripgrep / Python spelling of "case-insensitive" — and
 * JavaScript has no global-flag group, so `new RegExp('(?i)foo')` threw "unrecognized
 * character after (?" and grep refused the search outright (issue #182, gap 12). Every
 * server-side pattern compile goes through `compilePattern` (`@yaar/lib/regex-pattern`,
 * whose own rules are tested in `packages/lib/src/tests/regex-pattern.test.ts`), which
 * lifts a leading group of the flags JS has (i, m, s) into RegExp flags.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { applyReadOptions } from '../lib/read-options.js';
import { searchValuePaths } from '../lib/state-path.js';
import { storageWrite, storageDelete, storageGrep } from '../storage/storage-manager.js';

const SCRATCH = `temp/__regex-inline-flags-test-${process.pid}`;

describe('search sites accept (?i)', () => {
  beforeAll(async () => {
    await storageWrite(`${SCRATCH}/notes.md`, 'Design Token here\nnothing\n');
  });

  afterAll(async () => {
    await storageDelete(SCRATCH);
  });

  it('storage grep', async () => {
    const result = await storageGrep(SCRATCH, '(?i)design token');
    expect(result.success).toBe(true);
    expect(result.matches?.map((m) => m.line)).toEqual([1]);
  });

  it('storage grep still reports an invalid pattern', async () => {
    const result = await storageGrep(SCRATCH, '(?i)foo(');
    expect(result.success).toBe(false);
    expect(result.error).toStartWith('Invalid pattern:');
  });

  it('read { pattern } over text', () => {
    const out = applyReadOptions('Alpha\nbeta\nALPHA\n', 'f.txt', { pattern: '(?i)alpha' });
    expect(out).toContain('2 matching lines');
  });

  it('read { pattern } over a state value', () => {
    const out = searchValuePaths({ title: 'Hello', body: 'world' }, 'state', '(?i)HELLO');
    expect(out).toContain('1 of 2 values match');
  });
});
