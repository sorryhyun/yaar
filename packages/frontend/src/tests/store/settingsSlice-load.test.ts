/**
 * `loadSettings`'s own validation/clamping, exercised the only way it can be: by seeding
 * `localStorage` *before* the store module is ever evaluated, since `initial = loadSettings()`
 * runs once at module-eval time. A plain top-level statement in a test file still runs after
 * its static imports resolve (imports are hoisted ahead of a module's own body, regardless of
 * where they're written), so the seed has to land via a `await import()` performed *after* the
 * stub is in place — the same ordering `ConfirmDialog.test.tsx` relies on for `mock.module`.
 */
import { describe, it, expect } from 'bun:test';
import { DEFAULT_WINDOW_SIZE_PRESET } from '@yaar/shared';

const backing = new Map<string, string>();
backing.set(
  'yaar-settings',
  JSON.stringify({
    userName: 'Bob',
    language: 'de',
    wallpaper: 'nebula',
    accentColor: 'teal',
    // Not one of the three known sizes.
    iconSize: 'gigantic',
    // Not 'light', so the ternary in loadSettings should fall back to 'dark'.
    theme: 'blue',
    // Not 'left', so the ternary should fall back to 'right'.
    handedness: 'up',
    // Not one of WINDOW_SIZES, so it should clamp to DEFAULT_WINDOW_SIZE_PRESET.
    windowSize: 'huge',
  }),
);
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => backing.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { useDesktopStore } = await import('@/store');

describe('settingsSlice — loading a corrupted localStorage payload', () => {
  const state = useDesktopStore.getState();

  it('passes through fields with no validation as-is', () => {
    expect(state.userName).toBe('Bob');
    expect(state.language).toBe('de');
    expect(state.wallpaper).toBe('nebula');
    expect(state.accentColor).toBe('teal');
  });

  it('clamps an unrecognized theme to the dark default', () => {
    expect(state.theme).toBe('dark');
  });

  it('clamps an unrecognized handedness to the right default', () => {
    expect(state.handedness).toBe('right');
  });

  it('clamps an unrecognized windowSize to DEFAULT_WINDOW_SIZE_PRESET', () => {
    expect(state.windowSize).toBe(DEFAULT_WINDOW_SIZE_PRESET);
  });

  // Not a fix — documenting the current behavior. `loadSettings` validates `theme`,
  // `handedness` and `windowSize` against their known values but not `iconSize`, so a
  // corrupted/stale localStorage entry for it reaches state unclamped. Harmless in
  // practice today because every read site (`resolveIconSize`) already falls back on a
  // miss, but it is an inconsistency worth knowing about rather than relying on.
  it('does NOT clamp an unrecognized iconSize — passes the garbage value straight through', () => {
    expect(state.iconSize as string).toBe('gigantic');
  });
});
