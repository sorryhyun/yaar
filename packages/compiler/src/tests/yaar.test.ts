import { beforeEach, describe, expect, test } from 'bun:test';

/**
 * `appStorage.trySave` exists so a failed write stops being invisible. The thing
 * worth testing is therefore the reporting, not the write: that a failure is
 * always logged, that it toasts at most once per window (an autosave retries on
 * every tick), and that a success re-arms the toast.
 *
 * The shim reads `window.yaar` and `document` at module load, so both are stubbed
 * before the dynamic import below. The DOM surface `showToast` touches is small
 * enough to fake by hand — pulling in happy-dom for `createElement` would test
 * happy-dom.
 */

interface FakeEl {
  tag: string;
  className: string;
  textContent: string;
  value: string;
  placeholder: string;
  style: Record<string, string>;
  children: FakeEl[];
  onclick: ((e: unknown) => void) | null;
  appendChild(c: FakeEl): FakeEl;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  focus(): void;
  select(): void;
  remove(): void;
  classList: { add(c: string): void; remove(c: string): void };
  listeners: Record<string, ((e: unknown) => void)[]>;
}

type ToastEl = FakeEl;

const toasts: FakeEl[] = [];
const errors: string[] = [];
const docListeners: Record<string, ((e: unknown) => void)[]> = {};

let invokeImpl: (uri: string, payload: unknown) => Promise<unknown> = async () => ({});

function makeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    textContent: '',
    value: '',
    placeholder: '',
    style: {},
    children: [],
    onclick: null,
    listeners: {},
    appendChild: (c) => (el.children.push(c), c),
    setAttribute: () => {},
    addEventListener: (type, fn) => void (el.listeners[type] ??= []).push(fn),
    focus: () => {},
    select: () => {},
    remove: () => {
      const i = toasts.indexOf(el);
      if (i >= 0) toasts.splice(i, 1);
    },
    classList: { add: () => {}, remove: () => {} },
  };
  return el;
}

(globalThis as any).document = {
  body: { appendChild: (el: FakeEl) => void toasts.push(el) },
  createElement: (tag = 'div') => makeEl(tag),
  addEventListener: (type: string, fn: (e: unknown) => void) =>
    void (docListeners[type] ??= []).push(fn),
  removeEventListener: (type: string, fn: (e: unknown) => void) => {
    const arr = docListeners[type] ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  activeElement: null,
};
(globalThis as any).requestAnimationFrame = (cb: () => void) => {
  cb();
  return 0;
};
(globalThis as any).window = {
  yaar: {
    invoke: (uri: string, payload: unknown) => invokeImpl(uri, payload),
    // readJsonOr swallows the rejection and yields its fallback.
    read: async () => Promise.reject(new Error('no such file')),
    delete: async () => {},
    list: async () => [],
  },
};

const originalError = console.error;
console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
process.on('exit', () => {
  console.error = originalError;
});

const {
  appStorage,
  createCollapsiblePanel,
  createPersistedSignal,
  createProtocolContext,
  showAlert,
  showConfirm,
  showPrompt,
} = await import('../shims/yaar/index.js');

/** Lets microtask-scheduled saves (`void trySave(...)`) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const succeed = () => {
  invokeImpl = async () => ({});
};
const failWith = (message: string) => {
  invokeImpl = async () => Promise.reject(new Error(message));
};

describe('appStorage.trySave', () => {
  beforeEach(() => {
    toasts.length = 0;
    errors.length = 0;
    succeed();
  });

  test('resolves true and stays silent when the write lands', async () => {
    expect(await appStorage.trySave('ok.json', '{}')).toBe(true);
    expect(toasts).toBeEmpty();
    expect(errors).toBeEmpty();
  });

  test('resolves false, logs, and toasts when the write fails', async () => {
    failWith('disk full');
    expect(await appStorage.trySave('fail.json', '{}')).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe("Couldn't save fail.json: disk full");
    expect(toasts[0].className).toContain('y-toast-error');
    expect(errors).toHaveLength(1);
  });

  test('names the data with `label` instead of the path', async () => {
    failWith('disk full');
    await appStorage.trySave('draft.json', '{}', { label: 'deck' });
    expect(toasts[0].textContent).toBe("Couldn't save deck: disk full");
  });

  test('toasts a repeatedly-failing path once, but logs every failure', async () => {
    failWith('disk full');
    for (let i = 0; i < 4; i++) await appStorage.trySave('autosave.json', '{}');
    expect(toasts).toHaveLength(1);
    expect(errors).toHaveLength(4);
  });

  test('de-duplicates per path, not globally', async () => {
    failWith('disk full');
    await appStorage.trySave('a-1.json', '{}');
    await appStorage.trySave('b-1.json', '{}');
    expect(toasts).toHaveLength(2);
  });

  test('a success re-arms the toast for the next failure', async () => {
    failWith('disk full');
    await appStorage.trySave('flaky.json', '{}');
    succeed();
    await appStorage.trySave('flaky.json', '{}');
    failWith('disk full');
    await appStorage.trySave('flaky.json', '{}');
    expect(toasts).toHaveLength(2);
  });

  test('`onError` replaces the toast, but never the log', async () => {
    failWith('disk full');
    const seen: string[] = [];
    const ok = await appStorage.trySave('custom.json', '{}', {
      onError: (message) => void seen.push(message),
    });
    expect(ok).toBe(false);
    expect(seen).toEqual(['disk full']);
    expect(toasts).toBeEmpty();
    expect(errors).toHaveLength(1);
  });
});

describe('createPersistedSignal', () => {
  beforeEach(() => {
    toasts.length = 0;
    errors.length = 0;
    succeed();
  });

  test('reports a failed save rather than dropping it', async () => {
    const [, set] = createPersistedSignal('signal-1.json', { n: 0 });
    failWith('quota exceeded');
    set({ n: 1 });
    await tick();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe("Couldn't save signal-1.json: quota exceeded");
  });

  test('keeps the new value even though it was not persisted', async () => {
    const [get, set] = createPersistedSignal('signal-2.json', { n: 0 });
    failWith('quota exceeded');
    set({ n: 1 });
    await tick();
    expect(get()).toEqual({ n: 1 });
  });

  test('forwards `label` and `onError` to trySave', async () => {
    const seen: string[] = [];
    const [, set] = createPersistedSignal(
      'signal-3.json',
      { n: 0 },
      { label: 'document', onError: (message) => void seen.push(message) },
    );
    failWith('quota exceeded');
    set({ n: 1 });
    await tick();
    expect(seen).toEqual(['quota exceeded']);
    expect(toasts).toBeEmpty();
  });
});

/**
 * The dialog helpers replace native alert/confirm/prompt, whose defining bug is
 * that they block the page. What matters is the promise contract: which button
 * resolves to what, that Escape/backdrop mean cancel, and that a closed dialog
 * leaves neither DOM nor keydown listeners behind.
 */

const overlay = () => toasts.find((el) => el.className === 'y-overlay');

function flatten(el: FakeEl): FakeEl[] {
  return [el, ...el.children.flatMap(flatten)];
}

function buttons(): FakeEl[] {
  const o = overlay();
  return o ? flatten(o).filter((el) => el.tag === 'button') : [];
}

const okButton = () => buttons().find((b) => /y-btn-(primary|danger)/.test(b.className));
const cancelButton = () => buttons().find((b) => b.className === 'y-btn');
const inputField = () => {
  const o = overlay();
  return o ? flatten(o).find((el) => el.tag === 'input') : undefined;
};

const pressKey = (key: string, target?: unknown) => {
  for (const fn of [...(docListeners['keydown'] ?? [])]) {
    fn({ key, target, preventDefault: () => {}, stopPropagation: () => {} });
  }
};

describe('dialogs', () => {
  beforeEach(() => {
    toasts.length = 0;
    docListeners['keydown'] = [];
  });

  test('showConfirm resolves true on OK and removes the dialog', async () => {
    const p = showConfirm('Sure?');
    expect(overlay()).toBeDefined();
    okButton()!.onclick!({});
    expect(await p).toBe(true);
    expect(overlay()).toBeUndefined();
    expect(docListeners['keydown']).toBeEmpty();
  });

  test('showConfirm resolves false on Cancel', async () => {
    const p = showConfirm('Sure?');
    cancelButton()!.onclick!({});
    expect(await p).toBe(false);
  });

  test('showConfirm resolves false on Escape', async () => {
    const p = showConfirm('Sure?');
    pressKey('Escape');
    expect(await p).toBe(false);
    expect(overlay()).toBeUndefined();
  });

  test('showConfirm resolves false on backdrop click', async () => {
    const p = showConfirm('Sure?');
    const o = overlay()!;
    for (const fn of o.listeners['mousedown'] ?? []) fn({ target: o });
    expect(await p).toBe(false);
  });

  test('danger styles the OK button as y-btn-danger with a custom label', async () => {
    const p = showConfirm('Delete "a.txt"?', { danger: true, okLabel: 'Delete' });
    const ok = okButton()!;
    expect(ok.className).toContain('y-btn-danger');
    expect(ok.textContent).toBe('Delete');
    ok.onclick!({});
    await p;
  });

  test('showAlert has no cancel button and resolves on OK', async () => {
    const p = showAlert('Done.', { title: 'Export' });
    expect(cancelButton()).toBeUndefined();
    expect(flatten(overlay()!).some((el) => el.className === 'y-modal-title')).toBe(true);
    okButton()!.onclick!({});
    await p;
    expect(overlay()).toBeUndefined();
  });

  test('showPrompt resolves the typed value on OK', async () => {
    const p = showPrompt('Name:', { initial: 'Untitled' });
    const field = inputField()!;
    expect(field.value).toBe('Untitled');
    field.value = 'My doc';
    okButton()!.onclick!({});
    expect(await p).toBe('My doc');
  });

  test('showPrompt resolves the value on Enter in the field', async () => {
    const p = showPrompt('Name:');
    const field = inputField()!;
    field.value = 'quick';
    pressKey('Enter', field);
    expect(await p).toBe('quick');
  });

  test('showPrompt resolves null on cancel, even with text entered', async () => {
    const p = showPrompt('Name:');
    inputField()!.value = 'discarded';
    cancelButton()!.onclick!({});
    expect(await p).toBeNull();
  });
});

/**
 * The two gates exist because the reason to stay open is often owned by someone
 * other than the panel: a drag that began in a 3D viewport and swept across the
 * rail (`canOpen`), or a field inside the panel holding focus (`holdOpen`).
 * `holdOpen` is deliberately consulted when the fold *fires*, not when it is
 * armed, so a value that changes during the grace period is still respected.
 */
describe('createCollapsiblePanel', () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('folds after the grace period, not before', async () => {
    const panel = createCollapsiblePanel({ closeDelayMs: 5 });
    panel.open();
    panel.scheduleClose();
    expect(panel.expanded()).toBe(true);
    await settle(20);
    expect(panel.expanded()).toBe(false);
  });

  test('canOpen false refuses to expand', () => {
    const panel = createCollapsiblePanel({ canOpen: () => false });
    panel.open();
    expect(panel.expanded()).toBe(false);
  });

  test('canOpen false still cancels a pending fold', async () => {
    let allowed = true;
    const panel = createCollapsiblePanel({ closeDelayMs: 5, canOpen: () => allowed });
    panel.open();
    panel.scheduleClose();
    // The drag ends over the panel: it must not slam shut behind the pointer.
    allowed = false;
    panel.open();
    await settle(20);
    expect(panel.expanded()).toBe(true);
  });

  test('holdOpen skips the fold until whatever held it re-arms the close', async () => {
    let held = true;
    const panel = createCollapsiblePanel({ closeDelayMs: 5, holdOpen: () => held });
    panel.open();
    panel.scheduleClose();
    await settle(20);
    expect(panel.expanded()).toBe(true);

    held = false;
    panel.scheduleClose();
    await settle(20);
    expect(panel.expanded()).toBe(false);
  });

  test('a pin outranks canOpen', () => {
    const panel = createCollapsiblePanel({ canOpen: () => false });
    panel.togglePin();
    expect(panel.expanded()).toBe(true);
  });
});

describe('createProtocolContext', () => {
  test('get() returns the context installed by set()', () => {
    const holder = createProtocolContext('demo-app');
    const context = { n: 1 };
    holder.set(context);
    expect(holder.get()).toBe(context);
  });

  test('destructured set/get stay bound to their own holder', () => {
    // The documented usage is `export const { set, get } = createProtocolContext(...)`,
    // so the accessors must not depend on being called as methods.
    const { set, get } = createProtocolContext('demo-app');
    const other = createProtocolContext('other-app');
    set('mine');
    other.set('theirs');
    expect(get()).toBe('mine');
  });

  test('get() before set() throws naming the app, rather than returning undefined', () => {
    // Returning undefined here is the failure this helper exists to prevent:
    // it surfaces later as an unrelated TypeError deep inside a handler.
    const { get } = createProtocolContext('demo-app');
    expect(() => get()).toThrow(/demo-app.*read before it was set/s);
  });

  test('set() twice with a different context throws', () => {
    // Module state is shared by every descriptor, so a silent second install
    // would retarget the first registration's handlers.
    const { set } = createProtocolContext('demo-app');
    set({ n: 1 });
    expect(() => set({ n: 2 })).toThrow(/demo-app.*set twice/s);
  });

  test('set() twice with the identical context is a no-op', () => {
    const { set, get } = createProtocolContext('demo-app');
    const context = { n: 1 };
    set(context);
    set(context);
    expect(get()).toBe(context);
  });
});
