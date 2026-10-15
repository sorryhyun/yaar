/**
 * A leading PCRE-style flag group in a search pattern.
 *
 * Agents write `(?i)foo` — the ripgrep / Python spelling of "case-insensitive" — and
 * JavaScript has no global-flag group, so `new RegExp('(?i)foo')` threw "unrecognized
 * character after (?" and grep refused the search outright (issue #182, gap 12). Every
 * server-side pattern compile goes through `compilePattern`, which lifts a leading group
 * of the flags JS has (i, m, s) into RegExp flags.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { compilePattern } from '../lib/regex-pattern.js';
import { applyReadOptions } from '../lib/read-options.js';
import { searchValuePaths } from '../lib/state-path.js';
import { storageWrite, storageDelete, storageGrep } from '../storage/storage-manager.js';

const SCRATCH = `temp/__regex-inline-flags-test-${process.pid}`;

function compiled(pattern: string): RegExp {
  const result = compilePattern(pattern);
  if ('error' in result) throw new Error(result.error);
  return result.regex;
}

describe('compilePattern', () => {
  it('lifts a leading (?i) into the i flag', () => {
    const regex = compiled('(?i)design token');
    expect(regex.source).toBe('design token');
    expect(regex.flags).toBe('i');
    expect(regex.test('DESIGN Token')).toBe(true);
  });

  it('combines i, m and s', () => {
    expect(compiled('(?ims)a.b').flags).toBe('ims');
    expect(compiled('(?ii)x').flags).toBe('i');
  });

  it('leaves a pattern without a flag group alone', () => {
    const regex = compiled('Design');
    expect(regex.flags).toBe('');
    expect(regex.test('design')).toBe(false);
  });

  it('leaves other (? constructs to the engine', () => {
    expect(compiled('(?:ab)+').test('abab')).toBe(true);
    expect(compiled('(?<word>\\w+)').test('x')).toBe(true);
    expect(compiled('foo(?=bar)').test('foobar')).toBe(true);
    expect(compiled('(?i:foo)bar').test('FOObar')).toBe(true);
  });

  it('names the supported flags when given one JS lacks', () => {
    const result = compilePattern('(?x)foo');
    expect('error' in result && result.error).toContain('i, m and s');
  });

  it('still reports a genuinely broken pattern', () => {
    expect('error' in compilePattern('(?i)foo(')).toBe(true);
  });
});

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
