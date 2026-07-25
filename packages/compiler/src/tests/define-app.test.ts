/**
 * `defineApp()` is the blessed app entrypoint: it translates one authoring
 * object into an `app.register()` call and mounts the view.
 *
 * Three things are worth testing and none of them are testable the same way:
 *
 * 1. **The translation** (`get`/`run` -> `handler`, the `AppCommandError`
 *    contract, `replay` passthrough, `__authoritative`). Tested against the
 *    *compiled artifact*, not the shim source — an app never runs the source,
 *    and the interesting failure mode is a bundler-shaped one.
 * 2. **That `render` resolves.** The shim imports `solid-js/web` by its bare
 *    name and relies on the compiler plugin intercepting it so the app and the
 *    SDK share one reactive runtime. A green typecheck says nothing about that;
 *    only a real compile does, plus running the result and watching the view
 *    function actually get called by solid's `render`.
 * 3. **The types.** `run`'s parameter is derived from that command's own
 *    `params` schema. Nothing else in the suite would notice that silently
 *    degrading to `unknown`, so these cases run the real `tsc`, like
 *    `define-command.test.ts`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { compileTypeScript } from '../compile.js';
import { initCompiler } from '../config.js';
import { APP_MOUNT_ID } from '../mount-guard.js';
import { prebundleLibrary } from '../prebundle.js';
import { defineApp } from '../shims/yaar/define-app.js';
import { AppCommandError } from '../shims/yaar/ui.js';

// Real Bun.build()s and real tsc runs.
setDefaultTimeout(60_000);

const SHIM = resolve(import.meta.dir, '../shims/yaar/define-app.ts');
const BUNDLED_TYPES = resolve(import.meta.dir, '../bundled-types');
const TSC_JS = resolve(import.meta.dir, '../../node_modules/typescript/lib/tsc.js');

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

// ── A DOM small enough to hand-write ────────────────────────────────────────
// Only what registration and an imperative mount touch. A real DOM would mean a
// dependency; solid's own rendering is checked in a browser-shaped way below
// (the view function running is the observable that matters).

interface FakeEl {
  id: string;
  textContent: string;
  children: FakeEl[];
  appendChild(child: FakeEl): FakeEl;
  remove(): void;
}

function makeEl(id = ''): FakeEl {
  const el: FakeEl = {
    id,
    textContent: '',
    children: [],
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    remove() {},
  };
  return el;
}

interface Stubs {
  mount: FakeEl;
  registered: Record<string, any>[];
  errors: string[];
}

const savedGlobals = {
  window: (globalThis as any).window,
  document: (globalThis as any).document,
  error: console.error,
};

/** Install a window with the app-protocol SDK and a document containing `#app`. */
function installStubs(opts: { withMountElement?: boolean; withSdk?: boolean } = {}): Stubs {
  const { withMountElement = true, withSdk = true } = opts;
  const mount = makeEl(APP_MOUNT_ID);
  const registered: Record<string, any>[] = [];
  const errors: string[] = [];

  (globalThis as any).window = withSdk
    ? { yaar: { app: { register: (config: Record<string, any>) => void registered.push(config) } } }
    : {};
  (globalThis as any).document = {
    getElementById: (id: string) => (id === APP_MOUNT_ID && withMountElement ? mount : null),
    createElement: () => makeEl(),
  };
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));

  return { mount, registered, errors };
}

afterEach(() => {
  (globalThis as any).window = savedGlobals.window;
  (globalThis as any).document = savedGlobals.document;
  console.error = savedGlobals.error;
});

describe('defineApp registration', () => {
  test('translates the authoring shape into an authoritative registration', () => {
    const { registered } = installStubs();

    const definition = defineApp({
      id: 'memo',
      name: 'Memo',
      state: {
        memoCount: {
          description: 'Number of saved memos',
          schema: { type: 'number' },
          get: () => 7,
        },
      },
      commands: {
        addMemo: {
          description: 'Create a memo',
          aliases: ['newMemo'],
          params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          returns: { type: 'object' },
          replay: 'never',
          run: () => ({ id: 'm1' }),
        },
      },
      events: { memoAdded: { description: 'Fired after a memo is created' } },
    });

    expect(registered).toHaveLength(1);
    const config = registered[0];
    expect(config.appId).toBe('memo');
    expect(config.name).toBe('Memo');
    // The opt-in to the SDK's strict double-register guard. Without it a second
    // register() in this window would silently win.
    expect(config.__authoritative).toBe(true);

    // `get` -> `handler`, `run` -> `handler`; everything else rides along.
    expect(config.state.memoCount.description).toBe('Number of saved memos');
    expect(config.state.memoCount.schema).toEqual({ type: 'number' });
    expect(config.state.memoCount.handler()).toBe(7);
    expect(config.commands.addMemo.aliases).toEqual(['newMemo']);
    expect(config.commands.addMemo.params).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(config.commands.addMemo.returns).toEqual({ type: 'object' });
    // Untouched: the injected SDK reads it to build the ready handshake's noReplay list.
    expect(config.commands.addMemo.replay).toBe('never');
    expect(config.events).toEqual({ memoAdded: { description: 'Fired after a memo is created' } });

    // The definition comes back unchanged — the default export stays inspectable,
    // which is what lets the build read it.
    expect(definition.id).toBe('memo');
  });

  test('omits fields the app did not declare rather than sending undefined', () => {
    const { registered } = installStubs();
    defineApp({
      id: 'bare',
      name: 'Bare',
      commands: { ping: { description: 'Ping', run: () => 1 } },
    });

    const descriptor = registered[0].commands.ping;
    expect(Object.keys(descriptor).sort()).toEqual(['description', 'handler']);
    expect(registered[0].state).toEqual({});
    expect('events' in registered[0]).toBe(false);
  });

  test('is import-safe with no DOM at all', () => {
    // Slice D imports an app's entry module in a headless subprocess to fold its
    // schemas, so `defineApp(...)` at module scope must not throw when there is
    // no window and no document. If this test starts failing, the guards in
    // `mountView` were "simplified" away.
    (globalThis as any).window = undefined;
    (globalThis as any).document = undefined;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));

    const definition = defineApp({ id: 'headless', name: 'Headless', view: () => makeEl() });

    expect(definition.id).toBe('headless');
    // Silent: no window is the headless case, not a defect worth reporting.
    expect(errors).toEqual([]);
  });

  test('a browser window with no SDK is reported, not swallowed', () => {
    const { errors } = installStubs({ withSdk: false });
    defineApp({ id: 'orphan', name: 'Orphan' });
    expect(errors.join('\n')).toContain('window.yaar.app is missing');
  });
});

describe('defineApp command error contract', () => {
  function handlerFor(run: (params: unknown, ctx: unknown) => unknown) {
    const { registered } = installStubs();
    defineApp({ id: 'e', name: 'E', commands: { go: { description: 'Go', run } } });
    return registered[0].commands.go.handler;
  }

  test('a thrown plain Error surfaces as an AppCommandError, keeping the original', () => {
    const original = new Error('kaboom');
    const handler = handlerFor(() => {
      throw original;
    });
    // The bridge stringifies whatever comes out, so the name is what the agent reads.
    expect(() => handler({}, { replayed: false })).toThrow('kaboom');
    try {
      handler({}, { replayed: false });
    } catch (err) {
      expect((err as Error).name).toBe('AppCommandError');
      expect((err as { cause?: unknown }).cause).toBe(original);
    }
  });

  test('a rejected promise is wrapped the same way', async () => {
    const handler = handlerFor(async () => {
      throw new Error('async kaboom');
    });
    const rejection = await handler({}, { replayed: false }).catch((e: Error) => e);
    expect(rejection.name).toBe('AppCommandError');
    expect(rejection.message).toBe('async kaboom');
  });

  test('a non-Error throw still arrives as an AppCommandError', () => {
    const handler = handlerFor(() => {
      throw 'just a string';
    });
    try {
      handler({}, { replayed: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('AppCommandError');
      expect((err as Error).message).toBe('just a string');
    }
  });

  test('an AppCommandError passes through untouched', () => {
    const { registered } = installStubs();
    let thrown: unknown;
    defineApp({
      id: 'e',
      name: 'E',
      commands: {
        go: {
          description: 'Go',
          run: () => {
            thrown = new AppCommandError('deliberate');
            throw thrown;
          },
        },
      },
    });
    try {
      registered[0].commands.go.handler({}, { replayed: false });
    } catch (err) {
      expect(err).toBe(thrown);
    }
  });

  test('the handler ctx reaches run unchanged', () => {
    let seen: unknown;
    const handler = handlerFor((_params, ctx) => {
      seen = ctx;
      return 1;
    });
    handler({ a: 1 }, { replayed: true });
    expect(seen).toEqual({ replayed: true });
  });

  test('a successful result is returned, not swallowed', async () => {
    expect(handlerFor(() => 42)({}, { replayed: false })).toBe(42);
    expect(await handlerFor(async () => 'ok')({}, { replayed: false })).toBe('ok');
  });
});

describe('defineApp mounting', () => {
  test('mounts a { mount } view into the element the compiler emits', () => {
    const { mount } = installStubs();
    const mountedInto: FakeEl[] = [];
    defineApp({
      id: 'grid',
      name: 'Grid',
      view: {
        mount(el: FakeEl) {
          mountedInto.push(el);
          el.appendChild(makeEl('inner'));
        },
      },
    });
    expect(mountedInto).toEqual([mount]);
    expect(mount.children.map((c) => c.id)).toEqual(['inner']);
  });

  test("a view's teardown runs on close, after the app's own onClose", () => {
    const { registered } = installStubs();
    const order: string[] = [];
    defineApp({
      id: 'grid',
      name: 'Grid',
      onClose: () => void order.push('onClose'),
      view: { mount: () => () => void order.push('teardown') },
    });
    registered[0].onClose();
    expect(order).toEqual(['onClose', 'teardown']);
  });

  test('mounts nothing when the mount element is absent', () => {
    const { registered } = installStubs({ withMountElement: false });
    let mounted = false;
    defineApp({
      id: 'grid',
      name: 'Grid',
      view: { mount: () => void (mounted = true) },
    });
    // Registration still happened — an app with no visible UI still answers queries.
    expect(registered).toHaveLength(1);
    expect(mounted).toBe(false);
  });

  test('the mount id hardcoded in the shim still equals APP_MOUNT_ID', async () => {
    // The shim is browser code and must not import compiler internals, so the id
    // is duplicated there. This is the thing that makes the duplication safe: a
    // rename of APP_MOUNT_ID fails here instead of silently mounting nothing.
    const source = await Bun.file(SHIM).text();
    const literal = /const APP_MOUNT_ID = '([^']+)'/.exec(source);
    expect(literal).not.toBeNull();
    expect(literal![1]).toBe(APP_MOUNT_ID);
  });
});

// ── The compiled artifact ───────────────────────────────────────────────────

const sandboxes: string[] = [];

afterAll(async () => {
  await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Compile `source` as an app and return the emitted `<script type="module">` body. */
async function compileApp(appId: string, source: string) {
  const sandbox = await mkdtemp(join(tmpdir(), `yaar-define-app-${appId}-`));
  sandboxes.push(sandbox);
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), source);
  await Bun.write(
    join(sandbox, 'app.json'),
    JSON.stringify({ appId, name: appId, run: 'dist/index.html' }),
  );

  const result = await compileTypeScript(sandbox, { title: appId, minify: false });
  if (!result.success) throw new Error(`compile failed: ${(result.errors ?? []).join('\n')}`);

  const html = await Bun.file(join(sandbox, 'dist', 'index.html')).text();
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  expect(script).not.toBeNull();
  const modulePath = join(sandbox, 'app.mjs');
  await Bun.write(modulePath, script![1]);
  return { html, modulePath };
}

const IMPERATIVE_APP = `
import { defineApp } from '@bundled/yaar';

let host: HTMLElement | null = null;

export default defineApp({
  id: 'imperative',
  name: 'Imperative',
  state: { text: { description: 'Rendered text', get: () => host?.textContent ?? '' } },
  commands: {
    setText: {
      description: 'Set the text',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      replay: 'never',
      run: (p) => { if (host) host.textContent = p.text; return host?.textContent; },
    },
    fail: { description: 'Always fails', run: () => { throw new Error('nope'); } },
  },
  view: {
    mount(el) {
      host = document.createElement('div');
      host.textContent = 'mounted';
      el.appendChild(host);
      return () => { host = null; };
    },
  },
});
`;

const SOLID_APP = `
import { defineApp } from '@bundled/yaar';
import { createSignal } from '@bundled/solid-js';

const [count, setCount] = createSignal(0);

function App() {
  (globalThis as any).__yaarViewCalls = ((globalThis as any).__yaarViewCalls ?? 0) + 1;
  const el = document.createElement('div');
  el.textContent = 'count=' + count();
  return el;
}

export default defineApp({
  id: 'solidapp',
  name: 'Solid App',
  state: { count: { description: 'The count', get: () => count() } },
  commands: { bump: { description: 'Bump', run: () => setCount(count() + 1) } },
  view: App,
});
`;

describe('defineApp in a compiled app', () => {
  test('an imperative { mount } app registers and mounts', async () => {
    const { modulePath } = await compileApp('imperative', IMPERATIVE_APP);
    const { mount, registered } = installStubs();

    const module = await import(modulePath);

    expect(registered).toHaveLength(1);
    const config = registered[0];
    expect(config.appId).toBe('imperative');
    expect(config.__authoritative).toBe(true);
    expect(config.commands.setText.replay).toBe('never');

    // Mounted through the real bundle, into the real mount id.
    expect(mount.children).toHaveLength(1);
    expect(config.state.text.handler()).toBe('mounted');

    // The translated handler drives the app's own state.
    expect(config.commands.setText.handler({ text: 'hello' }, { replayed: false })).toBe('hello');
    expect(config.state.text.handler()).toBe('hello');

    // And the error contract survives bundling.
    expect(() => config.commands.fail.handler({}, { replayed: false })).toThrow('nope');
    try {
      config.commands.fail.handler({}, { replayed: false });
    } catch (err) {
      expect((err as Error).name).toBe('AppCommandError');
    }

    // The default export is the definition, unchanged.
    expect(module.default.id).toBe('imperative');
  });

  test("a Solid view is rendered by solid's own render, resolved from the shim", async () => {
    // `defineApp` imports `render` from a bare `solid-js/web`, which only works
    // because the compiler plugin intercepts `^solid-js(\\/|$)` from inside
    // bundled libraries. If that interception ever stops covering the shim, the
    // build fails outright; if it resolves to a *second* copy of solid, the app's
    // signals and the SDK's render effects stop seeing each other. Both are
    // caught here: the view function only runs if `render` really ran it, and the
    // bundle must contain exactly one solid runtime.
    const { html, modulePath } = await compileApp('solidapp', SOLID_APP);
    const { registered } = installStubs();
    delete (globalThis as any).__yaarViewCalls;

    await import(modulePath);

    expect(registered).toHaveLength(1);
    expect(registered[0].appId).toBe('solidapp');
    expect((globalThis as any).__yaarViewCalls).toBe(1);

    // One reactive runtime: solid's module body appears once in the bundle.
    const runtimeCopies = html.split('Symbol("solid-proxy")').length - 1;
    expect(runtimeCopies).toBe(1);
  });

  test('the prebundled @bundled/yaar carries no solid runtime of its own', async () => {
    // The exe embeds one artifact per bundled library. `@bundled/yaar` importing
    // solid means its artifact would embed a second reactive runtime and break
    // reactivity in exe builds *only* — with every build signal green. Solid is
    // marked external for it instead (see `solidExternals`), and redirected to the
    // shared prebundle at app-compile time.
    const code = await prebundleLibrary('yaar');
    expect(code).not.toContain('solid-proxy');
    expect(code).toContain('solid-js/web');
  });
});

// ── Types ───────────────────────────────────────────────────────────────────

let typeSandbox: string;

/** Typecheck `source` as an app's `src/main.ts` and return tsc's diagnostics. */
async function check(source: string): Promise<string[]> {
  await Bun.write(join(typeSandbox, 'src', 'main.ts'), source);
  const tsconfigPath = join(typeSandbox, 'tsconfig.json');
  await Bun.write(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        strict: false,
        noEmit: true,
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        paths: { '@bundled/*': [join(BUNDLED_TYPES, '*')] },
        skipLibCheck: true,
      },
      files: [join(BUNDLED_TYPES, 'index.d.ts')],
      include: ['src/**/*.ts'],
    }),
  );

  const proc = Bun.spawn([process.execPath, TSC_JS, '--noEmit', '-p', tsconfigPath], {
    cwd: typeSandbox,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('defineApp type inference', () => {
  beforeAll(async () => {
    typeSandbox = await mkdtemp(join(tmpdir(), 'yaar-define-app-types-'));
    await mkdir(join(typeSandbox, 'src'), { recursive: true });
  });

  afterAll(async () => {
    await rm(typeSandbox, { recursive: true, force: true });
  });

  test("each run's parameter is derived from that command's own params schema", async () => {
    const diagnostics = await check(`
      import { defineApp } from '@bundled/yaar';
      export default defineApp({
        id: 'demo',
        name: 'Demo',
        state: { n: { description: 'A number', get: () => 1 } },
        commands: {
          write: {
            description: 'Write',
            params: {
              type: 'object',
              properties: { text: { type: 'string' }, times: { type: 'number' } },
              required: ['text'],
            },
            replay: 'never',
            run: (p, ctx) => {
              const text: string = p.text;
              const times: number = p.times;
              const replayed: boolean = ctx.replayed;
              return { text, times, replayed };
            },
          },
          refresh: { description: 'Refresh', run: () => 1 },
        },
      });
    `);
    expect(diagnostics).toEqual([]);
  });

  test('a misspelled parameter key is a compile error', async () => {
    // The inference silently degrading to `unknown` would produce no error at
    // all, which is why this asserts on a rejection rather than on acceptance.
    const diagnostics = await check(`
      import { defineApp } from '@bundled/yaar';
      export default defineApp({
        id: 'demo',
        name: 'Demo',
        commands: {
          write: {
            description: 'Write',
            params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            run: (p) => p.txt,
          },
        },
      });
    `);
    expect(diagnostics.join('\n')).toContain("Property 'txt' does not exist");
  });

  test('an imperative view, events, and the lifecycle hooks all typecheck', async () => {
    const diagnostics = await check(`
      import { defineApp, type AppView } from '@bundled/yaar';
      const grid: AppView = { mount(el) { el.textContent = ''; return () => {}; } };
      export default defineApp({
        id: 'sheet',
        name: 'Sheet',
        state: { rows: { description: 'Row count', schema: { type: 'number' }, get: async () => 3 } },
        events: { edited: { description: 'A cell changed' } },
        view: grid,
        onClose: () => {},
        onCapture: () => null,
      });
    `);
    expect(diagnostics).toEqual([]);
  });

  test('a missing description is a compile error, not a runtime surprise', async () => {
    const diagnostics = await check(`
      import { defineApp } from '@bundled/yaar';
      export default defineApp({
        id: 'demo',
        name: 'Demo',
        commands: { silent: { run: () => 1 } },
      });
    `);
    expect(diagnostics.join('\n')).toContain('description');
  });
});
