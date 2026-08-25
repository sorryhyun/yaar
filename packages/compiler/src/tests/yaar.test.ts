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
/** Default: nothing stored, so `readJsonOr` swallows the rejection and yields its fallback. */
let readImpl: (uri: string, options?: unknown) => Promise<unknown> = async () => {
  throw new Error('no such file');
};
/** Every verb read the shim made, with the options it sent. Cleared per test that cares. */
const readCalls: { uri: string; options?: unknown }[] = [];

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
/**
 * The subset of `storageRefPath` (iframe-scripts/storage-sdk.ts) that `sharedStorage`
 * builds on. Stubbed with the real folding semantics rather than as an identity function:
 * what `sharedStorage` does is decide what to do *after* a reference is folded, and a
 * stub that folded nothing would pass while the real thing nested a path twice.
 */
function storageRefPath(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  let p = ref.trim();
  if (!p) return null;
  const appScoped = /^yaar:\/\/apps\/([^/]+)\/storage(?:\/|$)/.exec(p);
  if (appScoped) {
    const rest = p.slice(appScoped[0].length);
    p = 'apps/' + appScoped[1] + (rest ? '/' + rest : '');
  } else if (/^yaar:\/\/storage(?:\/|$)/.test(p)) {
    p = p.slice('yaar://storage'.length);
  } else if (p.startsWith('yaar://')) {
    return null;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
    return null;
  }
  p = p.replace(/^\/+/, '');
  return p.split('/').includes('..') ? null : p;
}

/** Every `window.yaar.storage` call, in order — what `sharedStorage` scoped and passed on. */
const storageCalls: { method: string; path: string; extra?: unknown }[] = [];

/**
 * The principal the fake server resolves `shared/self/` against, or null to leave the
 * pronoun standing.
 *
 * Null is the default so the bulk of the suite sees the spelling `sharedStorage` *sends*.
 * `sharedStorage` learns the real directory from any expanded path a call reports back
 * and then keeps it for the life of the module, so the one describe that exercises the
 * expansion sets this and runs last.
 */
let principalId: string | null = null;
const expandSelf = (p: string) =>
  principalId ? p.replace(/^shared\/self(?=\/|$)/, 'shared/' + principalId) : p;

(globalThis as any).window = {
  yaar: {
    invoke: (uri: string, payload: unknown) => invokeImpl(uri, payload),
    read: (uri: string, options?: unknown) => {
      readCalls.push({ uri, options });
      return readImpl(uri, options);
    },
    delete: async () => {},
    list: async () => [],
    storage: {
      path: storageRefPath,
      save: async (path: string, data: unknown) => {
        storageCalls.push({ method: 'save', path, extra: data });
        // `POST /api/storage/{path}` answers with the path it wrote, `self` expanded.
        return { ok: true, path: expandSelf(path) };
      },
      read: async (path: string, options?: unknown) => {
        storageCalls.push({ method: 'read', path, extra: options });
        return 'contents';
      },
      list: async (path: string) => {
        storageCalls.push({ method: 'list', path });
        return [{ path: expandSelf(path) + '/a.png', isDirectory: false }];
      },
      remove: async (path: string) => void storageCalls.push({ method: 'remove', path }),
      url: (path: string) => '/api/storage/' + path + '?__yaar_token=t',
    },
  },
};

const originalError = console.error;
console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
process.on('exit', () => {
  console.error = originalError;
});

/**
 * Imported per module, **not** through `../shims/yaar/index.js`.
 *
 * The barrel reaches `sanitize.ts`, which imports `dompurify`. Loading that through Bun's
 * *runtime* loader poisons the same `dist/purify.es.mjs` a later `Bun.build()` in this
 * process has to read, and the build dies with `EISDIR reading file:` on a file that is an
 * ordinary 118 KB regular file. It is the sibling of the defect `shims/dompurify.ts`
 * documents (there: entrypoint first, dependency second), reached from the other side, and
 * the shim's demotion trick does not help — the runtime loader is not the bundler.
 *
 * The damage lands in *another file*: `bun test yaar.test.ts define-app.test.ts` failed
 * four of define-app's app compiles, while either file alone passed. So the rule is not
 * "prefer narrow imports" but "no compiler test may load dompurify at runtime", and
 * `prebundle-completeness.test.ts` guards it by name rather than trusting this comment.
 *
 * What the barrel re-exports is covered where it can be checked without loading anything:
 * that same file prebundles `@bundled/yaar` and probes every export the artifact declares.
 */
const { appStorage } = await import('../shims/yaar/app-storage.js');
const { sharedStorage } = await import('../shims/yaar/shared-storage.js');
const { createCollapsiblePanel, createPersistedSignal } = await import('../shims/yaar/reactive.js');
const { createProtocolContext } = await import('../shims/yaar/protocol-context.js');
const { showConfirm, showPrompt } = await import('../shims/yaar/dialogs.js');
const { setAppId } = await import('../shims/yaar/app-identity.js');

/**
 * The app id is module-global and empty exactly once — here, before anything registers.
 * `setAppId('')` cannot recreate the state (it ignores an empty id on purpose), so a
 * claim about pre-registration behavior has to be captured at load or not at all.
 *
 * It used to throw ("this app has no id yet") because the directory name was built from
 * the declared id. The name is `shared/self` now and the server resolves it, so module
 * scope is an ordinary place to call from.
 */
const preRegistrationPath = sharedStorage.path('x.png');
setAppId('anima');

/** Lets microtask-scheduled saves (`void trySave(...)`) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const succeed = () => {
  invokeImpl = async () => ({});
};
const failWith = (message: string) => {
  invokeImpl = async () => Promise.reject(new Error(message));
};
const nothingStored = () => {
  readImpl = async () => {
    throw new Error('no such file');
  };
};
/** A stored value that arrives a macrotask late — the gap `ready` exists to close. */
const storedLate = (value: unknown) => {
  readImpl = () => new Promise((resolve) => setTimeout(() => resolve(value), 0));
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

/**
 * `readJsonOr` declares that an absent file is an expected answer. Before it could send
 * that declaration to the server it was a plain read wrapped in a `catch`, so every
 * optional config file an app had not written yet produced one `File not found` in the
 * session log — invisible to the app, which had already handled it, and counted against
 * the session all the same. What matters here is that the declaration is actually sent,
 * and that the `catch` still covers the servers and files it always did.
 */
describe('appStorage.readJsonOr', () => {
  beforeEach(() => {
    readCalls.length = 0;
    nothingStored();
  });

  test('tells the server absence is expected', async () => {
    await appStorage.readJsonOr('settings.json', { theme: 'dark' });
    expect(readCalls).toEqual([
      { uri: 'yaar://apps/self/storage/settings.json', options: { missingOk: true } },
    ]);
  });

  test('takes the fallback when the server answers null', async () => {
    readImpl = async () => null;
    expect(await appStorage.readJsonOr('settings.json', { theme: 'dark' })).toEqual({
      theme: 'dark',
    });
  });

  test('returns the stored value when there is one', async () => {
    readImpl = async () => ({ theme: 'light' });
    expect(await appStorage.readJsonOr('settings.json', { theme: 'dark' })).toEqual({
      theme: 'light',
    });
  });

  test('keeps a falsy stored value rather than mistaking it for absence', async () => {
    readImpl = async () => false;
    expect(await appStorage.readJsonOr('flag.json', true)).toBe(false);
  });

  // A server that predates `missingOk` ignores the option and fails the read as before.
  // An app compiled against this SDK has to keep working against one.
  test('still falls back when the read rejects', async () => {
    expect(await appStorage.readJsonOr('settings.json', { theme: 'dark' })).toEqual({
      theme: 'dark',
    });
  });
});

describe('createPersistedSignal', () => {
  beforeEach(() => {
    toasts.length = 0;
    errors.length = 0;
    succeed();
    nothingStored();
  });

  /**
   * The gap `ready` closes: a value only rendered self-corrects when the load lands,
   * but a one-shot side effect (`onMount`'s first fetch) reads the signal once and
   * cannot un-send what it sent. So the promise must resolve with the *stored* value,
   * must still resolve when nothing is stored, and must yield to a set that beat it —
   * awaiting it can never hand back a value the signal itself no longer holds.
   */
  describe('ready', () => {
    test('resolves with the stored value once the load lands', async () => {
      storedLate(true);
      const [get, , ready] = createPersistedSignal('concept-mode.json', false);
      expect(get()).toBe(false); // the window the bug lived in
      expect(await ready).toBe(true);
      expect(get()).toBe(true);
    });

    test('resolves with the fallback when nothing is stored', async () => {
      const [, , ready] = createPersistedSignal('absent.json', 'fallback');
      expect(await ready).toBe('fallback');
    });

    test('resolves with the revived value, not the raw one', async () => {
      storedLate(999);
      const [, , ready] = createPersistedSignal('clamped.json', 0, {
        revive: (raw) => Math.min(Number(raw), 100),
      });
      expect(await ready).toBe(100);
    });

    test('yields to a set that landed first, rather than reporting the stored value', async () => {
      storedLate('stored');
      const [get, set, ready] = createPersistedSignal('raced.json', '');
      set('typed');
      expect(await ready).toBe('typed');
      expect(get()).toBe('typed');
    });

    test('resolves rather than rejecting when the read fails', async () => {
      readImpl = async () => {
        throw new Error('storage offline');
      };
      const [, , ready] = createPersistedSignal('unreachable.json', 'fallback');
      expect(await ready).toBe('fallback');
    });
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

  /**
   * The reason `debounceMs` exists is a text input: `onInput` fires per keystroke
   * and an IME per composition step, so one typed name was a dozen writes. What
   * has to hold is that the burst collapses to one write carrying the *last*
   * value, that the default is still write-on-every-set, and that a window closing
   * mid-debounce does not eat the keystroke that made it worth debouncing.
   */
  describe('debounceMs', () => {
    const writes: string[] = [];

    beforeEach(() => {
      writes.length = 0;
      invokeImpl = async (_uri, payload) => {
        writes.push((payload as { content: string }).content);
        return {};
      };
    });

    test('writes on every set when it is not given', async () => {
      const [, set] = createPersistedSignal('eager.json', '');
      set('a');
      set('ab');
      set('abc');
      await tick();
      expect(writes).toEqual(['"a"', '"ab"', '"abc"']);
    });

    test('collapses a burst into one write carrying the last value', async () => {
      const [get, set] = createPersistedSignal('debounced.json', '', { debounceMs: 20 });
      for (const v of ['ㅈ', '주', '중', '주이', '주인']) set(v);
      // The signal is never debounced — only the write is. A box that lagged the
      // keystrokes by 20ms would be a worse bug than the one this fixes.
      expect(get()).toBe('주인');
      expect(writes).toBeEmpty();
      await new Promise((r) => setTimeout(r, 50));
      expect(writes).toEqual(['"주인"']);
    });

    test('flushes the pending write when the page is hidden', async () => {
      const [, set] = createPersistedSignal('hidden.json', '', { debounceMs: 5000 });
      set('typed, then closed');
      expect(writes).toBeEmpty();
      (globalThis as any).document.visibilityState = 'hidden';
      for (const fn of docListeners['visibilitychange'] ?? []) fn({});
      await tick();
      expect(writes).toEqual(['"typed, then closed"']);
      (globalThis as any).document.visibilityState = 'visible';
    });

    test('a flush leaves nothing owed, so the timer fires into a no-op', async () => {
      const [, set] = createPersistedSignal('once.json', '', { debounceMs: 20 });
      set('x');
      (globalThis as any).document.visibilityState = 'hidden';
      for (const fn of docListeners['visibilitychange'] ?? []) fn({});
      await new Promise((r) => setTimeout(r, 50));
      expect(writes).toEqual(['"x"']);
      (globalThis as any).document.visibilityState = 'visible';
    });
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

  test('a title renders above the message when one is given', async () => {
    const p = showConfirm('Overwrite "a.txt"?', { title: 'Export' });
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

/**
 * `sharedStorage` replaced three hand-rolled spellings of "my directory in the commons" —
 * anima's `const SHARED_DIR = 'shared/anima'`, lab's `sharedPath()`, slides-lite's
 * `SHARED_PREFIX` — so what is worth pinning is what those three disagreed about: whether
 * a subdirectory survives, and what happens to a name that already starts with `shared/`.
 *
 * Where the directory *name* comes from is no longer one of them, and that is the point of
 * the first test. It is `shared/self`, resolved by the server against the iframe token,
 * because building it from the declared id gave a devtools preview the shipped app's
 * commons directory — real user files, written by unshipped code.
 *
 * The refusals are here for the same reason: nesting a path the caller meant for `storage`
 * (`shared/anima/apps/anima/…`) writes real bytes somewhere nobody will look, silently.
 */
describe('sharedStorage naming', () => {
  beforeEach(() => {
    storageCalls.length = 0;
    setAppId('anima');
  });

  test('a bare name lands in this app’s commons directory, named by pronoun', () => {
    expect(sharedStorage.dir).toBe('shared/self');
    expect(sharedStorage.path('final.png')).toBe('shared/self/final.png');
    expect(sharedStorage.uri('final.png')).toBe('yaar://storage/shared/self/final.png');
  });

  test('the declared id is not what the path is built from', () => {
    // The whole fix: `anima` is registered, and no path says so. Under a preview the
    // same bundle is `preview--{projectId}` and only the server knows it.
    setAppId('anima');
    expect(sharedStorage.path('final.png')).not.toContain('anima');
  });

  test('a name is a subpath, not a flattened filename', () => {
    // anima flattened `/` to `-`; lab kept subdirectories. Subdirectories win — the
    // commons is a tree, and a producer with 200 renders wants to organize them.
    expect(sharedStorage.path('renders/final.png')).toBe('shared/self/renders/final.png');
  });

  test('a leading slash is ignored rather than making an empty segment', () => {
    expect(sharedStorage.path('/final.png')).toBe('shared/self/final.png');
  });

  test('a path this app’s own directory already spells out is re-based, not nested', () => {
    // What `list()` hands back, and the obvious thing to feed straight to `url()`. The
    // declared-id spelling is recognized and folded onto the pronoun rather than taken
    // literally — under a preview, taking it literally is the bug.
    expect(sharedStorage.path('shared/self/final.png')).toBe('shared/self/final.png');
    expect(sharedStorage.path('shared/anima/final.png')).toBe('shared/self/final.png');
    expect(sharedStorage.path('yaar://storage/shared/anima/final.png')).toBe(
      'shared/self/final.png',
    );
  });

  test('no argument names the directory itself', () => {
    expect(sharedStorage.path()).toBe('shared/self');
  });
});

describe('sharedStorage refusals', () => {
  beforeEach(() => setAppId('anima'));

  test('another app’s directory in the commons', () => {
    expect(() => sharedStorage.path('shared/lab/chart.png')).toThrow(/another app's directory/);
  });

  test('a path in another top-level tree is not nested under the commons', () => {
    expect(() => sharedStorage.path('apps/anima/generated/x.png')).toThrow(/"apps\/" tree/);
    expect(() => sharedStorage.path('yaar://apps/self/storage/x.png')).toThrow(/"apps\/" tree/);
    expect(() => sharedStorage.path('mounts/lectures/x.mp4')).toThrow(/"mounts\/" tree/);
  });

  test('traversal, and a reference that is not storage at all', () => {
    expect(() => sharedStorage.path('../lab/chart.png')).toThrow(/not a storage path/);
    expect(() => sharedStorage.path('https://example.com/x.png')).toThrow(/not a storage path/);
  });

  test('a name resolved before defineApp is not a failure at all', () => {
    // It threw "this app has no id yet" while the directory was named here. Nothing is
    // named here now, so module scope is an ordinary place to build a path.
    expect(preRegistrationPath).toBe('shared/self/x.png');
  });
});

describe('sharedStorage operations', () => {
  beforeEach(() => {
    storageCalls.length = 0;
    setAppId('anima');
  });

  test('save, read, remove and url all scope to the directory', async () => {
    await sharedStorage.save('final.png', 'bytes');
    await sharedStorage.read('final.png');
    await sharedStorage.readBlob('final.png');
    await sharedStorage.remove('final.png');

    expect(storageCalls.map((c) => [c.method, c.path])).toEqual([
      ['save', 'shared/self/final.png'],
      ['read', 'shared/self/final.png'],
      ['read', 'shared/self/final.png'],
      ['remove', 'shared/self/final.png'],
    ]);
    expect(storageCalls[2].extra).toEqual({ as: 'blob' });
    expect(sharedStorage.url('final.png')).toBe(
      '/api/storage/shared/self/final.png?__yaar_token=t',
    );
  });

  test('list defaults to the directory itself', async () => {
    await sharedStorage.list();
    await sharedStorage.list('renders');
    expect(storageCalls.map((c) => c.path)).toEqual(['shared/self', 'shared/self/renders']);
  });
});

describe('sharedStorage.publish', () => {
  let copies: { uri: string; payload: unknown }[] = [];

  beforeEach(() => {
    storageCalls.length = 0;
    copies = [];
    setAppId('anima');
    invokeImpl = async (uri, payload) => {
      copies.push({ uri, payload });
      return {};
    };
  });

  test('copies server-side and reports where it landed', async () => {
    const result = await sharedStorage.publish('yaar://apps/anima/storage/generated/x.png', {
      as: 'dragon.png',
    });

    expect(copies).toEqual([
      {
        uri: 'yaar://storage/shared/self/dragon.png',
        payload: { action: 'copy', from: 'yaar://apps/anima/storage/generated/x.png' },
      },
    ]);
    expect(result).toEqual({
      path: 'shared/self/dragon.png',
      uri: 'yaar://storage/shared/self/dragon.png',
      name: 'dragon.png',
    });
    // The bytes never came back through the iframe — that is the whole point of `publish`.
    // The one listing is `publish` asking what directory it just wrote to, because what it
    // returns is handed outward and the pronoun is only resolvable by this principal.
    expect(storageCalls.map((c) => c.method)).toEqual(['list']);
  });

  test('a yaar:// source is passed through unchanged so `self` survives', async () => {
    await sharedStorage.publish('yaar://apps/self/storage/generated/x.png');
    // Folding it to a root-relative path and rebuilding would yield
    // `yaar://storage/apps/self/x.png`, naming a literal directory called `self`:
    // `resolveSelf` expands only the `yaar://apps/self/…` dialect.
    expect((copies[0].payload as { from: string }).from).toBe(
      'yaar://apps/self/storage/generated/x.png',
    );
  });

  test('the name defaults to the source’s basename', async () => {
    const result = await sharedStorage.publish('yaar://apps/anima/storage/generated/x.png');
    expect(result.path).toBe('shared/self/x.png');
  });

  test('a source that is not stored bytes is refused', async () => {
    await expect(sharedStorage.publish('https://example.com/x.png')).rejects.toThrow(
      /not a stored file/,
    );
  });
});

/**
 * The preview case, and the reason for all of the above.
 *
 * The bundle says `anima`; the principal is `preview--1786428720812`. Every path is sent
 * as `shared/self/…`, so the write lands in the preview's own directory rather than in the
 * live app's — and once a call reports a resolved path back, the SDK answers with the real
 * directory, which is what an app hands to an agent.
 *
 * Runs last on purpose: the learned directory is module-global, exactly as it is in a
 * running app, and nothing after this would see the pronoun again.
 */
describe('sharedStorage under a devtools preview', () => {
  beforeEach(() => {
    storageCalls.length = 0;
    setAppId('anima');
    principalId = 'preview--1786428720812';
  });

  test('the write goes to the preview’s directory, not the shipped app’s', async () => {
    await sharedStorage.save('final.png', 'bytes');
    expect(storageCalls[0].path).toBe('shared/self/final.png');
    expect(storageCalls[0].path).not.toContain('anima');
  });

  test('what the server resolved is what the app reports afterwards', async () => {
    await sharedStorage.save('final.png', 'bytes');

    expect(sharedStorage.dir).toBe('shared/preview--1786428720812');
    expect(sharedStorage.path('next.png')).toBe('shared/preview--1786428720812/next.png');
    expect(sharedStorage.uri('next.png')).toBe(
      'yaar://storage/shared/preview--1786428720812/next.png',
    );
  });

  test('a round-trip of either spelling stays in the preview’s directory', async () => {
    await sharedStorage.save('final.png', 'bytes');

    expect(sharedStorage.path('shared/preview--1786428720812/final.png')).toBe(
      'shared/preview--1786428720812/final.png',
    );
    // The listing an agent or a deployed sibling produced, naming the shipped app.
    expect(sharedStorage.path('shared/anima/final.png')).toBe(
      'shared/preview--1786428720812/final.png',
    );
  });
});
