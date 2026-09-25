/**
 * `loadSettings` must not take the whole app down with it: a broken `yaar-settings` entry
 * (hand-edited, from an older schema, or a `getItem` that throws) has to fall back to
 * defaults instead of failing the store's module-eval. See `settingsSlice-load.test.ts` for
 * why the seed has to precede a dynamic `import()` rather than a static one.
 */
import { describe, it, expect } from 'bun:test';

globalThis.localStorage = {
  getItem: () => '{not valid json',
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage;

const { useDesktopStore } = await import('@/store');

describe('settingsSlice — loading a malformed localStorage entry', () => {
  it('falls back to defaults instead of throwing at import time', () => {
    const state = useDesktopStore.getState();
    expect(state.userName).toBe('');
    expect(state.language).toBe('en');
    expect(state.wallpaper).toBe('dark-blue');
    expect(state.accentColor).toBe('blue');
    expect(state.iconSize).toBe('medium');
    expect(state.theme).toBe('dark');
    expect(state.handedness).toBe('right');
  });
});
