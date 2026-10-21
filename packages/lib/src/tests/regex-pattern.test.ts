/**
 * A leading PCRE-style flag group in a search pattern.
 *
 * Agents write `(?i)foo` — the ripgrep / Python spelling of "case-insensitive" — and
 * JavaScript has no global-flag group, so `new RegExp('(?i)foo')` threw "unrecognized
 * character after (?" and grep refused the search outright (issue #182, gap 12).
 * `compilePattern` lifts a leading group of the flags JS has (i, m, s) into RegExp flags.
 * The server's search sites are covered through it in the server's
 * `regex-inline-flags.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { compilePattern } from '../regex-pattern.js';

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
