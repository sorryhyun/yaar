/**
 * The phone layout is picked by media query, and `?ui=` pins it either way — the pin has
 * to outlive the reload that drops the query string, and `?ui=auto` has to undo it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectFormFactor, readFormFactorOverride } from '@/lib/formFactor';

const realMatchMedia = globalThis.matchMedia;

// This partition runs without a DOM, so give the module a storage to remember pins in.
const store = new Map<string, string>();
globalThis.localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage;

function stubMatchMedia(matches: boolean) {
  globalThis.matchMedia = ((query: string) =>
    ({ matches, media: query }) as MediaQueryList) as typeof globalThis.matchMedia;
}

describe('form factor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    globalThis.matchMedia = realMatchMedia;
    localStorage.clear();
  });

  it('follows the media query when nothing is pinned', () => {
    stubMatchMedia(true);
    expect(detectFormFactor(readFormFactorOverride(''))).toBe('mobile');
    stubMatchMedia(false);
    expect(detectFormFactor(readFormFactorOverride(''))).toBe('desktop');
  });

  it('?ui= pins the layout and remembers it without the param', () => {
    stubMatchMedia(false);
    expect(detectFormFactor(readFormFactorOverride('?ui=mobile'))).toBe('mobile');
    expect(detectFormFactor(readFormFactorOverride(''))).toBe('mobile');
  });

  it('?ui=auto clears the pin', () => {
    stubMatchMedia(false);
    readFormFactorOverride('?ui=mobile');
    expect(readFormFactorOverride('?ui=auto')).toBeNull();
    expect(detectFormFactor(readFormFactorOverride(''))).toBe('desktop');
  });

  it('ignores a value it does not know', () => {
    expect(readFormFactorOverride('?ui=tablet')).toBeNull();
  });
});
