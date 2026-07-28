import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

/**
 * `createKeyState` exists so game apps get held-key tracking right by default.
 * What's worth testing is exactly the defaults: auto-repeat ignored, blur and
 * tab-hide clear held state (no stuck keys after alt-tab), releases keyed by
 * `e.code` so a modifier changing `e.key` mid-hold can't wedge a key, and
 * presses in editable elements skipped while releases still land.
 *
 * The shim reads `window`/`document` only inside `createKeyState`, so a
 * hand-rolled listener registry is enough — no happy-dom.
 */

const winListeners: Record<string, ((e: unknown) => void)[]> = {};
const docListeners: Record<string, ((e: unknown) => void)[]> = {};
let visibilityState = 'visible';

const listenerApi = (registry: Record<string, ((e: unknown) => void)[]>) => ({
  addEventListener: (type: string, fn: (e: unknown) => void) =>
    void (registry[type] ??= []).push(fn),
  removeEventListener: (type: string, fn: (e: unknown) => void) => {
    const arr = registry[type] ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
});

const hadWindow = 'window' in globalThis;
const hadDocument = 'document' in globalThis;
const prevWindow = (globalThis as unknown as { window?: unknown }).window;
const prevDocument = (globalThis as unknown as { document?: unknown }).document;

(globalThis as unknown as { window: unknown }).window = listenerApi(winListeners);
(globalThis as unknown as { document: unknown }).document = {
  ...listenerApi(docListeners),
  get visibilityState() {
    return visibilityState;
  },
};

afterAll(() => {
  if (hadWindow) (globalThis as unknown as { window: unknown }).window = prevWindow;
  else delete (globalThis as unknown as { window?: unknown }).window;
  if (hadDocument) (globalThis as unknown as { document: unknown }).document = prevDocument;
  else delete (globalThis as unknown as { document?: unknown }).document;
});

const { createKeyState } = await import('../shims/yaar/ui.js');

interface FakeKeyEvent {
  key: string;
  code: string;
  repeat: boolean;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(key: string, code: string, extra: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  const e: FakeKeyEvent = {
    key,
    code,
    repeat: false,
    target: null,
    defaultPrevented: false,
    preventDefault: () => {
      e.defaultPrevented = true;
    },
    ...extra,
  };
  return e;
}

const fire = (registry: Record<string, ((e: unknown) => void)[]>, type: string, e?: unknown) => {
  for (const fn of [...(registry[type] ?? [])]) fn(e);
};
const press = (key: string, code: string, extra: Partial<FakeKeyEvent> = {}) => {
  const e = keyEvent(key, code, extra);
  fire(winListeners, 'keydown', e);
  return e;
};
const release = (key: string, code: string, extra: Partial<FakeKeyEvent> = {}) => {
  const e = keyEvent(key, code, extra);
  fire(winListeners, 'keyup', e);
  return e;
};

beforeEach(() => {
  for (const registry of [winListeners, docListeners])
    for (const type of Object.keys(registry)) delete registry[type];
  visibilityState = 'visible';
});

describe('createKeyState', () => {
  test('tracks held keys by e.key and e.code, case-insensitive', () => {
    const keys = createKeyState();
    expect(keys.has('w')).toBe(false);
    press('w', 'KeyW');
    expect(keys.has('w')).toBe(true);
    expect(keys.has('W')).toBe(true);
    expect(keys.has('KeyW')).toBe(true);
    release('w', 'KeyW');
    expect(keys.has('w')).toBe(false);
    keys.dispose();
  });

  test('ignores OS auto-repeat but keeps the original press held', () => {
    const keys = createKeyState();
    press('w', 'KeyW');
    press('w', 'KeyW', { repeat: true });
    expect(keys.has('w')).toBe(true);
    release('w', 'KeyW');
    expect(keys.has('w')).toBe(false);
    keys.dispose();
  });

  test('release is keyed by e.code, so a modifier changing e.key cannot wedge a key', () => {
    const keys = createKeyState();
    press('w', 'KeyW');
    // Alt pressed mid-hold: macOS reports the release as key '∑', same code.
    release('∑', 'KeyW');
    expect(keys.has('w')).toBe(false);
    keys.dispose();
  });

  test('window blur and tab-hide clear held state', () => {
    const keys = createKeyState();
    press('w', 'KeyW');
    fire(winListeners, 'blur');
    expect(keys.has('w')).toBe(false);

    press('a', 'KeyA');
    visibilityState = 'hidden';
    fire(docListeners, 'visibilitychange');
    expect(keys.has('a')).toBe(false);
    keys.dispose();
  });

  test('skips presses in editable elements; releases still land', () => {
    const keys = createKeyState();
    const input = { tagName: 'INPUT', isContentEditable: false };
    press('w', 'KeyW', { target: input });
    expect(keys.has('w')).toBe(false);
    // Held on canvas, then released while an input has focus: must not stick.
    press('w', 'KeyW');
    release('w', 'KeyW', { target: input });
    expect(keys.has('w')).toBe(false);
    keys.dispose();
  });

  test('ignoreEditable: false tracks presses in editable elements', () => {
    const keys = createKeyState({ ignoreEditable: false });
    const input = { tagName: 'INPUT', isContentEditable: false };
    press('w', 'KeyW', { target: input });
    expect(keys.has('w')).toBe(true);
    keys.dispose();
  });

  test('preventDefault list suppresses matching keys, by key or code', () => {
    const keys = createKeyState({ preventDefault: ['arrowup', 'Space'] });
    expect(press('ArrowUp', 'ArrowUp').defaultPrevented).toBe(true);
    expect(press(' ', 'Space').defaultPrevented).toBe(true);
    expect(press('w', 'KeyW').defaultPrevented).toBe(false);
    // Suppression applies to auto-repeat too, even though tracking skips it.
    expect(press('ArrowUp', 'ArrowUp', { repeat: true }).defaultPrevented).toBe(true);
    keys.dispose();
  });

  test('dispose removes every listener and clears held state', () => {
    const keys = createKeyState();
    press('w', 'KeyW');
    keys.dispose();
    expect(keys.has('w')).toBe(false);
    expect(Object.values(winListeners).every((arr) => arr.length === 0)).toBe(true);
    expect(Object.values(docListeners).every((arr) => arr.length === 0)).toBe(true);
    press('w', 'KeyW');
    expect(keys.has('w')).toBe(false);
  });
});
