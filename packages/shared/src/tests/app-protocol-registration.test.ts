/**
 * The iframe SDK's up-front registration validation, plus the removal of the
 * public `app.register()`.
 *
 * `defineApp` builds the registration, so a failure here is a defect in the
 * definition the app handed it. The authoring types require appId, name, and a
 * { description, handler } per state key / command, but the runtime used to
 * accept anything: a missing appId/name/description silently became `undefined`
 * in the manifest, and a missing handler threw a bare "handler is not a
 * function" only when the member was later invoked — an error naming neither the
 * app nor the field. Registration now validates and throws naming the exact
 * missing field. This pins that contract.
 *
 * Registration is reached through `__registerApp`, the private entry `defineApp`
 * calls. The public `app.register()` is gone; the name survives only to throw a
 * message naming the replacement, which is tested here too — an app reaching for
 * it must not get a bare "not a function".
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the
 * browser runs it — evaluated with a stub `window` — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface Posted {
  type: string;
  appId?: string;
}

interface AppSdk {
  register: (c?: unknown) => void;
  __registerApp: (c: unknown) => void;
}

/** Install the protocol script over a stub window and return its `app` object. */
function installProtocol() {
  const posted: Posted[] = [];
  const window = {
    __yaarAppProtocolInstalled: false,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: () => {},
  } as Record<string, unknown>;

  new Function('window', IFRAME_APP_PROTOCOL_SCRIPT)(window);

  const app = (window.yaar as { app: AppSdk }).app;
  return { app, posted };
}

const goodState = { current: { description: 'the value', handler: () => 1 } };
const goodCommands = { go: { description: 'do it', handler: () => 'ok' } };

describe('registration validation', () => {
  it('accepts a well-formed registration and posts app-ready', () => {
    const { app, posted } = installProtocol();
    expect(() =>
      app.__registerApp({
        appId: 'demo',
        name: 'Demo',
        state: goodState,
        commands: goodCommands,
      }),
    ).not.toThrow();
    expect(posted.some((m) => m.type === 'yaar:app-ready' && m.appId === 'demo')).toBe(true);
  });

  it('accepts an app with only commands (no state)', () => {
    const { app } = installProtocol();
    expect(() =>
      app.__registerApp({ appId: 'demo', name: 'Demo', commands: goodCommands }),
    ).not.toThrow();
  });

  it('rejects a missing appId, naming the field', () => {
    const { app, posted } = installProtocol();
    expect(() => app.__registerApp({ name: 'Demo', commands: goodCommands })).toThrow(/"appId"/);
    expect(posted.some((m) => m.type === 'yaar:app-ready')).toBe(false);
  });

  it('rejects a missing name, naming the field', () => {
    const { app } = installProtocol();
    expect(() => app.__registerApp({ appId: 'demo', commands: goodCommands })).toThrow(/"name"/);
  });

  it('rejects a state descriptor missing its handler, naming key and field', () => {
    const { app } = installProtocol();
    expect(() =>
      app.__registerApp({ appId: 'demo', name: 'Demo', state: { current: { description: 'v' } } }),
    ).toThrow(/state\["current"\].*"handler"/s);
  });

  it('rejects a command descriptor missing its description, naming key and field', () => {
    const { app } = installProtocol();
    expect(() =>
      app.__registerApp({ appId: 'demo', name: 'Demo', commands: { go: { handler: () => 1 } } }),
    ).toThrow(/commands\["go"\].*"description"/s);
  });

  it('reports every problem at once, not just the first', () => {
    const { app } = installProtocol();
    let msg = '';
    try {
      app.__registerApp({ state: { a: {} } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/"appId"/);
    expect(msg).toMatch(/"name"/);
    expect(msg).toMatch(/state\["a"\]/);
  });

  it('rejects a non-object config', () => {
    const { app } = installProtocol();
    expect(() => app.__registerApp(null)).toThrow(/must be an object/);
  });

  it('refuses a second registration outright', () => {
    // `defineApp` owns registration timing: once, at module scope. A second one
    // can no longer be a component-body remount re-running register() — it is
    // two apps fighting over one iframe, and a silent winner would leave
    // protocol.json describing an app the iframe no longer runs.
    const { app } = installProtocol();
    app.__registerApp({ appId: 'first', name: 'First', commands: goodCommands });
    expect(() =>
      app.__registerApp({ appId: 'second', name: 'Second', commands: goodCommands }),
    ).toThrow(/"first" is already registered.*"second"/s);
  });
});

describe('the removed app.register()', () => {
  it('throws a message naming defineApp rather than a bare "not a function"', () => {
    // The name is kept only to explain itself. An app reaching for it is either
    // pre-defineApp source or a copied snippet, and a missing property would say
    // nothing about the replacement.
    const { app } = installProtocol();
    expect(typeof app.register).toBe('function');
    expect(() => app.register({ appId: 'demo', name: 'Demo', commands: goodCommands })).toThrow(
      /app\.register\(\) has been removed.*defineApp/s,
    );
  });

  it('registers nothing when called, so no app-ready is posted', () => {
    const { app, posted } = installProtocol();
    try {
      app.register({ appId: 'demo', name: 'Demo', commands: goodCommands });
    } catch {
      // expected
    }
    expect(posted.some((m) => m.type === 'yaar:app-ready')).toBe(false);
  });
});
