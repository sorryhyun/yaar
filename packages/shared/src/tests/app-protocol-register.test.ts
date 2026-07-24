/**
 * `app.register()`'s up-front shape validation.
 *
 * The authoring types require appId, name, and a { description, handler } per state
 * key / command, but the runtime used to accept anything: a missing appId/name/
 * description silently became `undefined` in the manifest, and a missing handler threw
 * a bare "handler is not a function" only when the member was later invoked — an error
 * naming neither the app nor the field. App authors were left reverse-engineering the
 * required shape from downstream failures. register() now validates and throws naming
 * the exact missing field. This pins that contract.
 *
 * The script is ES5 injected into an iframe, so it's exercised the way the browser runs
 * it — evaluated with a stub `window` — rather than pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface Posted {
  type: string;
  appId?: string;
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

  const app = (window.yaar as { app: { register: (c: unknown) => void } }).app;
  return { app, posted };
}

const goodState = { current: { description: 'the value', handler: () => 1 } };
const goodCommands = { go: { description: 'do it', handler: () => 'ok' } };

describe('app.register validation', () => {
  it('accepts a well-formed registration and posts app-ready', () => {
    const { app, posted } = installProtocol();
    expect(() =>
      app.register({ appId: 'demo', name: 'Demo', state: goodState, commands: goodCommands }),
    ).not.toThrow();
    expect(posted.some((m) => m.type === 'yaar:app-ready' && m.appId === 'demo')).toBe(true);
  });

  it('accepts an app with only commands (no state)', () => {
    const { app } = installProtocol();
    expect(() =>
      app.register({ appId: 'demo', name: 'Demo', commands: goodCommands }),
    ).not.toThrow();
  });

  it('rejects a missing appId, naming the field', () => {
    const { app, posted } = installProtocol();
    expect(() => app.register({ name: 'Demo', commands: goodCommands })).toThrow(/"appId"/);
    expect(posted.some((m) => m.type === 'yaar:app-ready')).toBe(false);
  });

  it('rejects a missing name, naming the field', () => {
    const { app } = installProtocol();
    expect(() => app.register({ appId: 'demo', commands: goodCommands })).toThrow(/"name"/);
  });

  it('rejects a state descriptor missing its handler, naming key and field', () => {
    const { app } = installProtocol();
    expect(() =>
      app.register({ appId: 'demo', name: 'Demo', state: { current: { description: 'v' } } }),
    ).toThrow(/state\["current"\].*"handler"/s);
  });

  it('rejects a command descriptor missing its description, naming key and field', () => {
    const { app } = installProtocol();
    expect(() =>
      app.register({ appId: 'demo', name: 'Demo', commands: { go: { handler: () => 1 } } }),
    ).toThrow(/commands\["go"\].*"description"/s);
  });

  it('reports every problem at once, not just the first', () => {
    const { app } = installProtocol();
    let msg = '';
    try {
      app.register({ state: { a: {} } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/"appId"/);
    expect(msg).toMatch(/"name"/);
    expect(msg).toMatch(/state\["a"\]/);
  });

  it('rejects a non-object config', () => {
    const { app } = installProtocol();
    expect(() => app.register(null)).toThrow(/requires a config object/);
  });
});
