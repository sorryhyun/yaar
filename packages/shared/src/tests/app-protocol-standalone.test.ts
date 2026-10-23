/**
 * `window.yaarApp`: the app protocol called directly, for a page running outside YAAR.
 *
 * A page published as a claude.ai Artifact has no desktop to send protocol requests,
 * and the agent there drives the HTML in its own headless browser. The global gives it
 * the same commands and state the bridge serves, with the same error messages, and is
 * kept out of a window inside YAAR, where the server-gated bridge is the only door.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_APP_PROTOCOL_SCRIPT } from '../iframe-scripts/app-protocol.js';

interface YaarApp {
  manifest(): { appId: string; commands: Record<string, unknown> } | null;
  state(key: string): Promise<unknown>;
  command(name: string, params?: Record<string, unknown>): Promise<unknown>;
  describe(key: string): Promise<string | null>;
}

type StubWindow = Record<string, unknown> & { yaarApp?: YaarApp };

/** Evaluate the script over a stub window; `top` makes it its own parent, as a top window is. */
function install(opts: { top?: boolean; claude?: boolean }): StubWindow {
  const window: StubWindow = {
    __yaarAppProtocolInstalled: false,
    addEventListener: () => {},
    postMessage: () => {},
  };
  window.parent = opts.top ? window : { postMessage: () => {} };
  if (opts.claude) window.claude = { use: async () => null };
  new Function('window', IFRAME_APP_PROTOCOL_SCRIPT)(window);
  return window;
}

function register(window: StubWindow) {
  let count = 0;
  (window.yaar as { app: { __registerApp: (c: unknown) => void } }).app.__registerApp({
    appId: 'demo',
    name: 'Demo',
    state: {
      count: { description: 'Current count', handler: () => count },
    },
    commands: {
      add: {
        description: 'Add n',
        aliases: ['plus'],
        params: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        handler: (p: { n: number }) => {
          count += p.n;
          return { count };
        },
        describe: () => 'Adds n to the count.',
      },
      reset: {
        description: 'Reset',
        handler: () => {
          count = 0;
        },
      },
    },
  });
}

describe('window.yaarApp', () => {
  it('is not installed inside YAAR', () => {
    expect(install({}).yaarApp).toBeUndefined();
  });

  it('is installed in a top window and in a claude.ai viewer frame', () => {
    expect(install({ top: true }).yaarApp).toBeDefined();
    expect(install({ claude: true }).yaarApp).toBeDefined();
  });

  it('serves the manifest, state and commands, aliases included', async () => {
    const window = install({ top: true });
    const app = window.yaarApp!;
    expect(app.manifest()).toBeNull();
    register(window);

    expect(Object.keys(app.manifest()!.commands).sort()).toEqual(['add', 'reset']);
    expect(await app.command('add', { n: 2 })).toEqual({ count: 2 });
    expect(await app.command('plus', { n: 3 })).toEqual({ count: 5 });
    expect(await app.state('count')).toBe(5);
    // A command that returns nothing resolves null, as the bridge answers it.
    expect(await app.command('reset')).toBeNull();
    expect(await app.describe('add')).toBe('Adds n to the count.');
    expect(await app.describe('count')).toBe('Current count');
  });

  it('rejects with the bridge messages', async () => {
    const window = install({ top: true });
    register(window);
    const app = window.yaarApp!;

    await expect(app.command('ad', { n: 1 })).rejects.toThrow('Did you mean "add"?');
    await expect(app.command('count')).rejects.toThrow('is a state key, not a command');
    await expect(app.command('add', { m: 1 })).rejects.toThrow('missing required param: n');
    await expect(app.state('add')).rejects.toThrow('is a command, not a state key');
  });
});
