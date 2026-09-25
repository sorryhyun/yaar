/**
 * Three call sites (`resolveWindowKey`, `monitorOfWindowId`, `windowsSlice`'s local
 * `resolveKey`) each used to scan `windows` for a key ending in `/rawId` themselves.
 * `findWindowKeyBySuffix` is the one scan; these cases pin its contract plus the
 * per-caller fallback each keeps on top of it, and the other small pure helpers
 * living beside them in `store/helpers.ts`.
 */
import { describe, it, expect } from 'bun:test';
import {
  generateId,
  capArray,
  toWindowKey,
  findWindowKeyBySuffix,
  resolveWindowKey,
  monitorOfWindowId,
  emptyContentByRenderer,
} from '@/store/helpers';

describe('generateId', () => {
  it('prefixes the id', () => {
    expect(generateId('cli')).toMatch(/^cli-\d+-[a-z0-9]+$/);
  });

  it('is different across calls', () => {
    expect(generateId('cli')).not.toBe(generateId('cli'));
  });
});

describe('capArray', () => {
  it('leaves a short array alone', () => {
    expect(capArray([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('keeps the most recent entries once over the cap', () => {
    expect(capArray([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });
});

describe('toWindowKey', () => {
  it('joins monitor and raw id with a slash', () => {
    expect(toWindowKey('0', 'notes')).toBe('0/notes');
  });
});

describe('findWindowKeyBySuffix', () => {
  it('finds a key ending in /rawId', () => {
    const windows = { '0/notes': {}, '1/memo': {} };
    expect(findWindowKeyBySuffix(windows, 'memo')).toBe('1/memo');
  });

  it('returns undefined when nothing matches', () => {
    expect(findWindowKeyBySuffix({ '0/notes': {} }, 'memo')).toBeUndefined();
  });

  it('does not match a rawId that is only a substring, not a /-delimited suffix', () => {
    // "win-1" must not match a key ending in "other-win-1" unless that key's suffix
    // is literally "/win-1" — endsWith('/win-1') on "0/other-win-1" is false, since
    // the character before "win-1" there is "r", not "/".
    const windows = { '0/other-win-1': {} };
    expect(findWindowKeyBySuffix(windows, 'win-1')).toBeUndefined();
  });

  it('does match when the id truly is a /-delimited suffix of another', () => {
    const windows = { '0/other/win-1': {} };
    expect(findWindowKeyBySuffix(windows, 'win-1')).toBe('0/other/win-1');
  });

  it('returns the first match in key order when more than one key ends in the suffix', () => {
    const windows = { '0/notes': {}, '1/notes': {} };
    expect(findWindowKeyBySuffix(windows, 'notes')).toBe('0/notes');
  });
});

describe('resolveWindowKey', () => {
  it('returns the id as-is on an exact match, even if it would also suffix-match another key', () => {
    // "0/notes" both exists as a key and would suffix-match "1/0/notes" — exact
    // match wins, and is checked before any scan.
    const windows = { '0/notes': {}, '1/0/notes': {} };
    expect(resolveWindowKey(windows, '0/notes', '9')).toBe('0/notes');
  });

  it('scans for a suffix match when there is no exact match', () => {
    const windows = { '0/notes': {} };
    expect(resolveWindowKey(windows, 'notes', '9')).toBe('0/notes');
  });

  it('falls back to scoping the raw id under the given monitor when nothing is found', () => {
    expect(resolveWindowKey({}, 'notes', '9')).toBe('9/notes');
  });

  it('a rawId that is only a substring of another key does not false-match', () => {
    const windows = { '0/other-win-1': {} };
    expect(resolveWindowKey(windows, 'win-1', '9')).toBe('9/win-1');
  });
});

describe('monitorOfWindowId', () => {
  it('reads the monitor straight off a scoped key without touching `windows`', () => {
    expect(monitorOfWindowId({}, '3/notes')).toBe('3');
  });

  it('reads monitorId off an exact-match window', () => {
    const windows = { notes: { monitorId: '2' } };
    expect(monitorOfWindowId(windows, 'notes')).toBe('2');
  });

  it('suffix-scans and prefers the found window’s own monitorId', () => {
    const windows = { '1/notes': { monitorId: '5' } };
    expect(monitorOfWindowId(windows, 'notes')).toBe('5');
  });

  it('suffix-scans and falls back to the key’s own prefix when monitorId is missing', () => {
    const windows = { '1/notes': {} };
    expect(monitorOfWindowId(windows, 'notes')).toBe('1');
  });

  it('returns undefined, not a guess, when the id cannot be told apart', () => {
    expect(monitorOfWindowId({}, 'notes')).toBeUndefined();
  });

  it('a rawId that is only a substring of another key does not false-match', () => {
    const windows = { '0/other-win-1': { monitorId: '0' } };
    expect(monitorOfWindowId(windows, 'win-1')).toBeUndefined();
  });

  it('an unscoped id whose own entry has no monitorId, and no suffix match exists, is undefined', () => {
    const windows = { notes: {} };
    expect(monitorOfWindowId(windows, 'notes')).toBeUndefined();
  });
});

describe('emptyContentByRenderer', () => {
  it('is an empty string for text-shaped renderers', () => {
    expect(emptyContentByRenderer('markdown')).toBe('');
    expect(emptyContentByRenderer('html')).toBe('');
    expect(emptyContentByRenderer('text')).toBe('');
    expect(emptyContentByRenderer('component')).toBe('');
    expect(emptyContentByRenderer('iframe')).toBe('');
  });

  it('is an empty table shape for the table renderer', () => {
    expect(emptyContentByRenderer('table')).toEqual({ headers: [], rows: [] });
  });

  it('is null for anything unrecognized', () => {
    expect(emptyContentByRenderer('nonsense')).toBeNull();
  });
});
