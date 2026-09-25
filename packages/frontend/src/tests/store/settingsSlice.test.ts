/**
 * Settings slice — user preferences persisted to localStorage and, for most fields,
 * pushed to the server via `PATCH /api/settings`. `localStorage` isn't in
 * `test-setup.ts`'s happy-dom global list, so `saveSettings`/`loadSettings` hit a
 * `ReferenceError` under test — caught by their own try/catch, which is what lets the
 * store still import cleanly elsewhere. Here it's stubbed with a Map-backed fake so the
 * persistence itself is actually observable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useDesktopStore } from '@/store';
import { DEFAULT_WINDOW_SIZE_PRESET } from '@yaar/shared';

const STORAGE_KEY = 'yaar-settings';

const realLocalStorage = globalThis.localStorage;
const realFetch = globalThis.fetch;

let backing: Map<string, string>;
let patchRequests: { url: string; body: Record<string, unknown> }[];

function readPersisted(): Record<string, unknown> | null {
  const raw = backing.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

describe('settingsSlice', () => {
  beforeEach(() => {
    backing = new Map();
    globalThis.localStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    patchRequests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      patchRequests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    useDesktopStore.setState({
      userName: '',
      language: 'en',
      wallpaper: 'dark-blue',
      accentColor: 'blue',
      iconSize: 'medium',
      theme: 'dark',
      handedness: 'right',
      windowSize: DEFAULT_WINDOW_SIZE_PRESET,
    });
  });

  afterEach(() => {
    globalThis.localStorage = realLocalStorage;
    globalThis.fetch = realFetch;
  });

  it('setUserName updates state and persists, without a server round trip', () => {
    useDesktopStore.getState().setUserName('Ada');
    expect(useDesktopStore.getState().userName).toBe('Ada');
    expect(readPersisted()).toMatchObject({ userName: 'Ada' });
    expect(patchRequests).toEqual([]);
  });

  it('setLanguage updates state, persists, and PATCHes the server', () => {
    useDesktopStore.getState().setLanguage('ko');
    expect(useDesktopStore.getState().language).toBe('ko');
    expect(readPersisted()).toMatchObject({ language: 'ko' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { language: 'ko' } }]);
  });

  it('applyServerLanguage updates state and persists, but does not PATCH the server back', () => {
    useDesktopStore.getState().applyServerLanguage('ja');
    expect(useDesktopStore.getState().language).toBe('ja');
    expect(readPersisted()).toMatchObject({ language: 'ja' });
    expect(patchRequests).toEqual([]);
  });

  it('setWallpaper updates state, persists, and PATCHes wallpaper', () => {
    useDesktopStore.getState().setWallpaper('sunset');
    expect(useDesktopStore.getState().wallpaper).toBe('sunset');
    expect(readPersisted()).toMatchObject({ wallpaper: 'sunset' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { wallpaper: 'sunset' } }]);
  });

  it('setAccentColor updates state, persists, and PATCHes accentColor', () => {
    useDesktopStore.getState().setAccentColor('red');
    expect(useDesktopStore.getState().accentColor).toBe('red');
    expect(readPersisted()).toMatchObject({ accentColor: 'red' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { accentColor: 'red' } }]);
  });

  it('setTheme updates state, persists, and PATCHes theme', () => {
    useDesktopStore.getState().setTheme('light');
    expect(useDesktopStore.getState().theme).toBe('light');
    expect(readPersisted()).toMatchObject({ theme: 'light' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { theme: 'light' } }]);
  });

  it('setIconSize updates state, persists, and PATCHes iconSize', () => {
    useDesktopStore.getState().setIconSize('large');
    expect(useDesktopStore.getState().iconSize).toBe('large');
    expect(readPersisted()).toMatchObject({ iconSize: 'large' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { iconSize: 'large' } }]);
  });

  it('setHandedness updates state, persists, and PATCHes handedness', () => {
    useDesktopStore.getState().setHandedness('left');
    expect(useDesktopStore.getState().handedness).toBe('left');
    expect(readPersisted()).toMatchObject({ handedness: 'left' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { handedness: 'left' } }]);
  });

  it('setWindowSize updates state, persists, and PATCHes windowSize', () => {
    useDesktopStore.getState().setWindowSize('large');
    expect(useDesktopStore.getState().windowSize).toBe('large');
    expect(readPersisted()).toMatchObject({ windowSize: 'large' });
    expect(patchRequests).toEqual([{ url: '/api/settings', body: { windowSize: 'large' } }]);
  });

  it('persists every field together, not just the one just set — later setters read live state', () => {
    useDesktopStore.getState().setUserName('Ada');
    useDesktopStore.getState().setTheme('light');
    expect(readPersisted()).toMatchObject({ userName: 'Ada', theme: 'light' });
  });

  it('applyServerSettings only overwrites the fields present in the payload', () => {
    useDesktopStore.getState().setUserName('Ada');
    useDesktopStore.getState().applyServerSettings({ handedness: 'left' });

    const state = useDesktopStore.getState();
    expect(state.handedness).toBe('left');
    expect(state.userName).toBe('Ada'); // untouched
    expect(readPersisted()).toMatchObject({ userName: 'Ada', handedness: 'left' });
  });

  it('applyServerSettings changes the language when included, and persists it', () => {
    useDesktopStore.getState().applyServerSettings({ language: 'fr' });
    expect(useDesktopStore.getState().language).toBe('fr');
    expect(readPersisted()).toMatchObject({ language: 'fr' });
    // Server-originated — must not PATCH back to the server that just told us.
    expect(patchRequests).toEqual([]);
  });

  it('applyServerSettings with an empty payload changes nothing observable', () => {
    const before = { ...useDesktopStore.getState() };
    useDesktopStore.getState().applyServerSettings({});
    const after = useDesktopStore.getState();
    expect(after.userName).toBe(before.userName);
    expect(after.theme).toBe(before.theme);
  });

  it('a save that throws (storage disabled/full) does not throw out of the action', () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;

    expect(() => useDesktopStore.getState().setUserName('Grace')).not.toThrow();
    expect(useDesktopStore.getState().userName).toBe('Grace');
  });
});
