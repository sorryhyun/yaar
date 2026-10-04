/**
 * `defineApp({ debug })` → `__debug` in a devtools preview's eval.
 *
 * The bundle is an ES module, so an eval sees none of the app's own bindings; the
 * debug hook is the one sanctioned window into them. The gate is the eval itself —
 * the server only sends one to a preview — so the global must not exist until an
 * eval arrives, and must then answer with the hook re-read on every access.
 *
 * Exercised the way the browser runs the script: evaluated over a stub `window`,
 * with the message listener captured and fed an eval request.
 */
import { describe, it, expect } from 'bun:test';
import { APP_MSG } from '../app-protocol.js';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface Posted {
  type: string;
  value?: string;
  error?: string;
}

type Listener = (e: { data: unknown }) => void;

function install(win: Record<string, unknown> = {}) {
  const posted: Posted[] = [];
  let listener: Listener | undefined;
  Object.assign(win, {
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listener = fn;
    },
  });
  new Function('window', IFRAME_APP_PROTOCOL_SCRIPT)(win);
  const app = (win.yaar as { app: { __registerApp: (c: unknown) => void } }).app;
  const evaluate = (expression: string) =>
    listener?.({ data: { type: APP_MSG.evalRequest, requestId: 'r1', expression } });
  return { win, app, posted, evaluate };
}

const commands = { go: { description: 'do it', handler: () => 'ok' } };

describe('__debug', () => {
  it('does not exist before an eval arrives', () => {
    const { win, app } = install();
    app.__registerApp({ appId: 'demo', name: 'Demo', commands, debug: { x: 1 } });
    expect('__debug' in win).toBe(false);
  });

  it('serves the declared object once an eval has run', () => {
    const { win, app, evaluate } = install();
    const engine = { voices: 3 };
    app.__registerApp({ appId: 'demo', name: 'Demo', commands, debug: { engine } });
    evaluate('1');
    expect((win.__debug as { engine: unknown }).engine).toBe(engine);
  });

  it('re-reads the function form on every access', () => {
    const { win, app, evaluate } = install();
    let current = { n: 1 };
    app.__registerApp({ appId: 'demo', name: 'Demo', commands, debug: () => ({ current }) });
    evaluate('1');
    expect((win.__debug as { current: { n: number } }).current.n).toBe(1);
    current = { n: 2 };
    expect((win.__debug as { current: { n: number } }).current.n).toBe(2);
  });

  it('names the fix when the app declares no hook', () => {
    const { win, app, evaluate } = install();
    app.__registerApp({ appId: 'demo', name: 'Demo', commands });
    evaluate('1');
    expect(() => win.__debug).toThrow(/"demo" declares no debug hook.*defineApp\(\{ debug/s);
  });

  it('says the app never registered when that is the cause', () => {
    const { win, evaluate } = install();
    evaluate('1');
    expect(() => win.__debug).toThrow(/has not registered/);
  });

  it('rejects a debug value that is neither an object nor a function', () => {
    const { app } = install();
    expect(() =>
      app.__registerApp({ appId: 'demo', name: 'Demo', commands, debug: 'engine' }),
    ).toThrow(/"debug" must be an object or a function/);
  });

  it('is reachable from the evaluated expression itself', () => {
    // The browser's window is the global an indirect eval runs against; here that
    // means installing over globalThis, and putting back what was there.
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = ['parent', 'addEventListener', 'yaar', '__yaarAppProtocolInstalled'].map(
      (k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const,
    );
    try {
      const { app, posted, evaluate } = install(g);
      app.__registerApp({ appId: 'demo', name: 'Demo', commands, debug: () => ({ n: 41 }) });
      evaluate('__debug.n + 1');
      const answer = posted.find((m) => m.type === APP_MSG.evalResponse);
      expect(answer?.error).toBeUndefined();
      expect(answer?.value).toBe('42');
    } finally {
      delete g.__debug;
      delete g.__yaarAppRegistered;
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      }
    }
  });
});
