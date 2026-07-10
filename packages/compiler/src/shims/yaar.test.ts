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

interface ToastEl {
  className: string;
  textContent: string;
}

const toasts: ToastEl[] = [];
const errors: string[] = [];

let invokeImpl: (uri: string, payload: unknown) => Promise<unknown> = async () => ({});

(globalThis as any).document = {
  body: { appendChild: (el: ToastEl) => void toasts.push(el) },
  createElement: (): ToastEl & Record<string, unknown> =>
    ({
      className: '',
      textContent: '',
      classList: { add: () => {}, remove: () => {} },
      remove: () => {},
    }) as any,
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

const { appStorage, createPersistedSignal } = await import('./yaar.ts');

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
