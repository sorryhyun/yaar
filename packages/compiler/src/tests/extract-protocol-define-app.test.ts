/**
 * Protocol extraction from `export default defineApp({...})`.
 *
 * The `app.register()` path locates the registration by heuristic — which
 * receiver is the SDK's `app`, which of two shaped candidates is real. Under
 * `defineApp` there is nothing to guess: the default export's config object *is*
 * the protocol. This suite pins that, and pins the three ways the new shape can
 * still lie about the running app:
 *
 *   ID       — `id` must equal the app.json `appId`, because the id is what the
 *              app registers under and what protocol.json is filed against.
 *   EXCLUSION— `defineApp` plus `app.register()` is two registrations; the
 *              manifest can describe only one and cannot tell which wins.
 *   REPLAY   — `replay: 'never'` must reach the manifest, or the server replays
 *              a command the app opted out of on every iframe remount.
 *
 * The reach the legacy path has (spreads across modules, `const` refs, identity
 * wrappers) is shared code, and is re-asserted here rather than assumed: it is
 * the property that lets a protocol be split by domain, and losing it silently
 * costs commands.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import {
  extractProtocolFromModules,
  formatProtocolError,
  type ExtractOptions,
} from '../extract-protocol-ast.js';
import { extractProtocolFromDir } from '../extract-protocol-dir.js';

/** Extract from an in-memory module map rooted at `src/main.ts`. */
function extract(files: Record<string, string>, options: ExtractOptions = {}) {
  return extractProtocolFromModules(ts, 'src/main.ts', (path) => files[path] ?? null, options);
}

/** The import the extractor keys on. The shim itself is not needed to parse it. */
const IMPORT = `import { defineApp } from '@bundled/yaar';`;

/** Every rejection produces a null manifest and a located, ASCII error. */
function expectRejected(
  files: Record<string, string>,
  contains: string,
  options: ExtractOptions = {},
) {
  const { protocol, errors } = extract(files, options);
  expect(protocol).toBeNull();
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.map(formatProtocolError).join('\n')).toContain(contains);
  for (const err of errors) {
    expect(err.line).toBeGreaterThan(0);
    expect(err.column).toBeGreaterThan(0);
    // Compiler error paths mangle non-ASCII bytes.
    expect(err.message).toMatch(/^[\x20-\x7e]*$/);
  }
}

describe('defineApp: reach', () => {
  test('the default export config is the protocol', () => {
    const { protocol, errors } = extract(
      {
        'src/main.ts': `${IMPORT}
        const App = () => null;
        export default defineApp({
          id: 'memo',
          name: 'Memo',
          state: {
            memoCount: {
              description: 'Number of saved memos',
              schema: { type: 'number' },
              get: () => 3,
            },
          },
          commands: {
            addMemo: {
              description: 'Create a memo',
              aliases: ['newMemo'],
              params: { type: 'object', properties: { text: { type: 'string' } } },
              returns: { type: 'object', properties: { id: { type: 'string' } } },
              replay: 'never',
              run: async (_p: unknown) => ({ id: 'x' }),
            },
          },
          events: { memoAdded: { description: 'Fired after a memo is created' } },
          view: App,
          onClose: () => {},
        });`,
      },
      { appId: 'memo' },
    );

    expect(errors).toEqual([]);
    expect(protocol).toEqual({
      state: { memoCount: { description: 'Number of saved memos', schema: { type: 'number' } } },
      commands: {
        addMemo: {
          description: 'Create a memo',
          aliases: ['newMemo'],
          replay: 'never',
          params: { type: 'object', properties: { text: { type: 'string' } } },
          returns: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
      events: { memoAdded: { description: 'Fired after a memo is created' } },
    });
  });

  test('descriptors spread in from another module are followed', () => {
    // The property that lets a protocol be split by domain. It is shared code
    // with the legacy path, so this is a regression test for the refactor.
    const { protocol, errors } = extract({
      'src/commands/files.ts': `
        import { gitCommands } from './git';
        export const fileCommands = {
          ...gitCommands,
          readFile: { description: 'Read', run: () => '' },
        };`,
      'src/commands/git.ts': `
        export const gitCommands = { commit: { description: 'Commit', run: () => '' } };`,
      'src/main.ts': `${IMPORT}
        import { fileCommands } from './commands/files';
        export default defineApp({
          id: 'd',
          name: 'D',
          commands: { ...fileCommands, ping: { description: 'Ping', run: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['commit', 'readFile', 'ping']);
  });

  test('a `const` config and an aliased import still resolve', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `import { defineApp as makeApp } from '@bundled/yaar';
        const config = {
          id: 'd',
          name: 'D',
          commands: { go: { description: 'Go', run: () => 1 } },
        };
        const instance = makeApp(config);
        export default instance;`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
  });

  test('defineCommand stays transparent', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `import { defineApp, defineCommand } from '@bundled/yaar';
        export default defineApp({
          id: 'd',
          name: 'D',
          commands: { go: defineCommand({ description: 'Go', run: () => 1 }) },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.go.description).toBe('Go');
  });

  test('method shorthand is a handler, not a broken descriptor', () => {
    // `run(p) {...}` and `onClose() {...}` are ordinary ways to write these, and
    // neither is a value the manifest reads. The register() path still rejects
    // method shorthand, where it means a pseudo-descriptor.
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd',
          name: 'D',
          state: { n: { description: 'N', get() { return 1; } } },
          commands: { go: { description: 'Go', run(_p: unknown) { return 1; } } },
          onClose() {},
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
    expect(Object.keys(protocol!.state)).toEqual(['n']);
  });

  test('replay: always is carried through as written', () => {
    const { protocol } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd', name: 'D',
          commands: { nav: { description: 'Nav', replay: 'always', run: () => 1 } },
        });`,
    });

    expect(protocol!.commands.nav.replay).toBe('always');
  });

  test('a command that says nothing about replay carries no replay field', () => {
    // Absent means `always` at the server; emitting it would make every existing
    // manifest churn for no change in behavior.
    const { protocol } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd', name: 'D',
          commands: { nav: { description: 'Nav', run: () => 1 } },
        });`,
    });

    expect(protocol!.commands.nav).toEqual({ description: 'Nav' });
  });
});

describe('defineApp: id', () => {
  test('an id that disagrees with app.json is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            id: 'memos',
            name: 'Memo',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      "declared `memos` but this app's app.json says `memo`",
      { appId: 'memo' },
    );
  });

  test('a missing id is an error even with no app.json to compare against', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            name: 'Memo',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      'missing `id`',
    );
  });

  test('no known app id skips the comparison rather than failing', () => {
    // A bare sandbox has no app.json. It is not wrong about anything, so it
    // builds.
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'whatever',
          name: 'W',
          commands: { go: { description: 'Go', run: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
  });

  test('a computed id is not statically resolvable', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          const suffix = String(Date.now());
          export default defineApp({
            id: 'memo-' + suffix,
            name: 'M',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      '`defineApp.id`',
      { appId: 'memo' },
    );
  });
});

describe('defineApp: mutual exclusion with app.register()', () => {
  test('importing defineApp and calling app.register() is an error', () => {
    expectRejected(
      {
        'src/main.ts': `import { defineApp, app } from '@bundled/yaar';
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go', run: () => 1 } },
          });
          app.register({ appId: 'd', name: 'D', commands: {} });`,
      },
      'both register the app',
    );
  });

  test('the register() call may live in another module and is still caught', () => {
    expectRejected(
      {
        'src/legacy.ts': `import { app } from '@bundled/yaar';
          export function registerLegacy(): void {
            app.register({ appId: 'd', name: 'D', commands: {} });
          }`,
        'src/main.ts': `${IMPORT}
          import './legacy';
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      'both register the app',
    );
  });
});

describe('defineApp: refusal', () => {
  test('two defineApp calls are ambiguous', () => {
    expectRejected(
      {
        'src/other.ts': `import { defineApp } from '@bundled/yaar';
          export const other = defineApp({ id: 'd', name: 'D', commands: {} });`,
        'src/main.ts': `${IMPORT}
          import './other';
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      'a window hosts exactly one app',
    );
  });

  test('a defineApp that is not the default export is an error, not a silent skip', () => {
    // Falling through to the legacy search would find no register() and report
    // "no protocol" for an app with commands - the silent outcome this module
    // exists to prevent.
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go', run: () => 1 } },
          });`,
      },
      'must be the default export',
    );
  });

  test('a state key with no getter is refused', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            id: 'd', name: 'D',
            state: { n: { description: 'N' } },
          });`,
      },
      'missing `get`',
    );
  });

  test('a command with no run is refused', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go' } },
          });`,
      },
      'missing `run`',
    );
  });

  test('an unknown replay policy is refused', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'Go', replay: 'once', run: () => 1 } },
          });`,
      },
      "expected 'always' or 'never'",
    );
  });

  test('a commands map built by a call is refused, as on the legacy path', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          function build() { return { gen: { description: 'Gen', run: () => 1 } }; }
          export default defineApp({
            id: 'd', name: 'D',
            commands: { good: { description: 'Good', run: () => 1 }, ...build() },
          });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a description missing from one descriptor rejects the whole manifest', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({
            id: 'd', name: 'D',
            commands: {
              good: { description: 'Good', run: () => 1 },
              bad: { run: () => 2 },
            },
          });`,
      },
      'missing `description`',
    );
  });
});

describe('defineApp: absence', () => {
  test("an app's own defineApp is not the SDK's", () => {
    // It resolves locally, so it is this app's function. Whatever it does, the
    // registration it performs is found the legacy way or not at all.
    const { protocol, errors } = extract({
      'src/main.ts': `
        const app = { register(_c: unknown): void {} };
        function defineApp<T>(config: T): T { return config; }
        const instance = defineApp({ id: 'd' });
        void instance;
        app.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', handler: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
  });

  test('an app that neither defines nor registers yields nothing', () => {
    expect(extract({ 'src/main.ts': `document.title = 'x';` })).toMatchObject({
      protocol: null,
      errors: [],
    });
  });
});

describe('app.register() is unchanged', () => {
  const APP = `const app = { register(_c: unknown): void {} };`;

  test('a legacy registration extracts exactly as before', () => {
    const { protocol, errors } = extract(
      {
        'src/main.ts': `${APP}
        app.register({
          appId: 'demo',
          name: 'Demo',
          state: { status: { description: 'Status', handler: () => 'ok' } },
          commands: {
            ping: {
              description: 'Ping',
              aliases: ['p'],
              params: { type: 'object', properties: { n: { type: 'number' } } },
              returns: { type: 'string' },
              handler: () => 'pong',
            },
          },
          events: { tick: { description: 'A tick' } },
        });`,
      },
      // A known app id must not change what the legacy path extracts: it has no
      // `id` field to check, and inventing one would fail every existing app.
      { appId: 'demo' },
    );

    expect(errors).toEqual([]);
    expect(protocol).toEqual({
      state: { status: { description: 'Status' } },
      commands: {
        ping: {
          description: 'Ping',
          aliases: ['p'],
          params: { type: 'object', properties: { n: { type: 'number' } } },
          returns: { type: 'string' },
        },
      },
      events: { tick: { description: 'A tick' } },
    });
  });

  test('an app.json id that disagrees with the legacy appId is not an error', () => {
    // The check belongs to `defineApp`, whose `id` the runtime registers under.
    // Applying it here would fail apps that ship today.
    const { protocol, errors } = extract(
      {
        'src/main.ts': `${APP}
          app.register({
            appId: 'something-else', name: 'D',
            commands: { go: { description: 'Go', handler: () => 1 } },
          });`,
      },
      { appId: 'demo' },
    );

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
  });

  test('method shorthand in a legacy descriptor is still rejected', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          app.register({
            appId: 'd', name: 'D',
            commands: { go: { description: 'Go', handler() { return 1; } } },
          });`,
      },
      'method shorthand is not a descriptor',
    );
  });

  test('a legacy command may declare a replay policy and it reaches the manifest', () => {
    // The iframe runtime reads `replay` off whatever registration it is handed,
    // `defineApp` or not. A manifest that dropped it here would let the server
    // replay a command the running app opted out of.
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'd', name: 'D',
          commands: { add: { description: 'Add', replay: 'never', handler: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.add.replay).toBe('never');
  });
});

describe('the app id reaches the extractor from app.json', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  /** Lay out a real app directory and extract from it the way a build does. */
  async function extractApp(files: Record<string, string>) {
    dir = await mkdtemp(join(tmpdir(), 'yaar-define-app-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await Bun.write(join(dir, rel), content);
    }
    return extractProtocolFromDir(join(dir, 'src'));
  }

  const MAIN = (id: string) => `${IMPORT}
    export default defineApp({
      id: '${id}',
      name: 'Memo',
      commands: { addMemo: { description: 'Create a memo', run: () => 1 } },
    });`;

  test('an id matching app.json extracts cleanly', async () => {
    const result = await extractApp({
      'app.json': JSON.stringify({ appId: 'memo', name: 'Memo' }),
      'src/main.ts': MAIN('memo'),
    });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.protocol!.commands)).toEqual(['addMemo']);
  });

  test('an id disagreeing with app.json fails', async () => {
    // The id is read from app.json's `appId`, not from the directory name -
    // getting the key wrong here would silently disable the check.
    const result = await extractApp({
      'app.json': JSON.stringify({ appId: 'memo', name: 'Memo' }),
      'src/main.ts': MAIN('notes'),
    });

    expect(result.protocol).toBeNull();
    expect(result.errors.map(formatProtocolError).join('\n')).toContain(
      "declared `notes` but this app's app.json says `memo`",
    );
  });

  test('a sandbox with no app.json still builds', async () => {
    const result = await extractApp({ 'src/main.ts': MAIN('scratch') });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.protocol!.commands)).toEqual(['addMemo']);
  });
});
