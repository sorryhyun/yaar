/**
 * The AST protocol extractor.
 *
 * These tests are about the two properties the manifest has to hold, in tension:
 *
 *   REACH    — a descriptor may live in another file and arrive via a spread,
 *              so a protocol file can be split by domain.
 *   REFUSAL  — anything not statically resolvable is an error with a location,
 *              never an omission. A silently-dropped command is invisible to
 *              agents while the app still works, which is the worst outcome
 *              available: every signal stays green and the capability is gone.
 *
 * There is no second reader left to guard: the text scanner this replaced is
 * deleted, and without `typescript` an `app.register()` app is refused outright
 * (see `fold-schemas.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { extractProtocolFromModules, formatProtocolError } from '../extract-protocol-ast.js';

/** Extract from an in-memory module map rooted at `src/main.ts`. */
function extract(files: Record<string, string>, entry = 'src/main.ts') {
  return extractProtocolFromModules(ts, entry, (path) => files[path] ?? null);
}

const APP = `const app = { register(_c: unknown): void {} };`;

describe('reach', () => {
  test('extracts a plain literal registration', () => {
    const { protocol, errors } = extract({
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
    });

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

  test('follows spreads of descriptor maps across relative imports', () => {
    const { protocol, errors } = extract({
      'src/commands/files.ts': `
        import { gitCommands } from './git';
        export const fileCommands = {
          ...gitCommands,
          readFile: { description: 'Read', handler: () => '' },
        };`,
      'src/commands/git.ts': `
        export const gitCommands = { commit: { description: 'Commit', handler: () => '' } };`,
      'src/main.ts': `${APP}
        import { fileCommands } from './commands/files';
        app.register({ appId: 'd', name: 'D', commands: { ...fileCommands } });`,
    });

    expect(errors).toEqual([]);
    // Nested spread first, matching source order.
    expect(Object.keys(protocol!.commands)).toEqual(['commit', 'readFile']);
  });

  test('a whole section may be an imported const', () => {
    const { protocol, errors } = extract({
      'src/state.ts': `export const appState = { a: { description: 'A', handler: () => 1 } };`,
      'src/main.ts': `${APP}
        import { appState } from './state';
        app.register({ appId: 'd', name: 'D', state: appState });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.state)).toEqual(['a']);
  });

  test('sees through defineCommand and other single-argument wrappers', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const defineCommand = <T,>(d: T): T => d;
        app.register({
          appId: 'd', name: 'D',
          commands: { ping: defineCommand({ description: 'Ping', handler: () => 1 }) },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Ping');
  });

  test('joins `+`-concatenated strings, including inside params', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'd', name: 'D',
          commands: {
            go: {
              description: 'One ' + 'two ' + 'three',
              params: {
                type: 'object',
                properties: { mode: { description: 'a ' + 'b', type: 'string' } },
              },
              handler: () => 1,
            },
          },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.go.description).toBe('One two three');
    // The text scanner dropped the whole params block when it held a `+`.
    expect(protocol!.commands.go.params).toEqual({
      type: 'object',
      properties: { mode: { description: 'a b', type: 'string' } },
    });
  });

  test('unwraps `as const` and resolves a named descriptor', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const pingCommand = { description: 'Ping', handler: () => 1 } as const;
        app.register({ appId: 'd', name: 'D', commands: { ping: pingCommand } });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Ping');
  });

  test('later keys win, as they do at runtime', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const base = { ping: { description: 'Base', handler: () => 1 } };
        app.register({
          appId: 'd', name: 'D',
          commands: { ...base, ping: { description: 'Override', handler: () => 2 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Override');
  });

  test('finds the registration when main.ts only imports it', () => {
    const { protocol, errors } = extract({
      'src/protocol.ts': `${APP}
        export function registerProtocol() {
          app.register({ appId: 'd', name: 'D', commands: { ping: { description: 'P', handler: () => 1 } } });
        }`,
      'src/main.ts': `import { registerProtocol } from './protocol';\nregisterProtocol();`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['ping']);
  });

  test('the built-in `manifest` state key is not re-declared', () => {
    const { protocol } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'd', name: 'D',
          state: {
            manifest: { description: 'Built in', handler: () => null },
            real: { description: 'Real', handler: () => 1 },
          },
        });`,
    });

    expect(Object.keys(protocol!.state)).toEqual(['real']);
  });
});

describe('refusal', () => {
  /** Every rejection must produce a manifest of null and a located error. */
  function expectRejected(files: Record<string, string>, contains: string) {
    const { protocol, errors } = extract(files);
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

  test('a local binding wins over a module binding of the same name', () => {
    // Resolving to the module-level `pingCommand` here would produce a manifest
    // that disagrees with the runtime and says nothing about it.
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const pingCommand = { description: 'Module', handler: () => 1 };
        void pingCommand;
        export function setup() {
          const pingCommand = { description: 'Local', handler: () => 2 };
          app.register({ appId: 'd', name: 'D', commands: { ping: pingCommand } });
        }`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Local');
  });

  test('a descriptor shadowed by a parameter is an error, not the module binding', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          const cmds = { ping: { description: 'Module', handler: () => 1 } };
          void cmds;
          export function setup(cmds: Record<string, unknown>) {
            app.register({ appId: 'd', name: 'D', commands: { ...cmds } });
          }`,
      },
      'spread source could not be resolved',
    );
  });

  test('a `let` is not read as its initializer', () => {
    // `refresh()` reassigns it before register() runs, so the initializer is not
    // the value the runtime registers. Reporting it would be a silent lie.
    expectRejected(
      {
        'src/main.ts': `${APP}
          let description = 'initial';
          function refresh() { description = 'actual'; }
          refresh();
          app.register({
            appId: 'd', name: 'D',
            commands: { go: { description, handler: () => 1 } },
          });`,
      },
      'could not be resolved',
    );
  });

  test('a wrapper that is not an identity function is an error', () => {
    // Stepping over this call would report 'Old cmd' while the runtime
    // registers 'Old cmd (deprecated)'.
    expectRejected(
      {
        'src/main.ts': `${APP}
          function withDeprecation(cmd: { description: string }) {
            return { ...cmd, description: cmd.description + ' (deprecated)' };
          }
          app.register({
            appId: 'd', name: 'D',
            commands: { old: withDeprecation({ description: 'Old cmd', handler: () => 1 }) },
          });`,
      },
      'commands.old',
    );
  });

  test('a locally-declared non-identity `defineCommand` is not trusted by name', () => {
    // The SDK's `defineCommand` is trusted because it is imported from a package
    // and documented as identity. A function of the same name declared *here* is
    // just a function, and stepping over it would report 'Go' while the runtime
    // registers 'Go [shadow]'.
    expectRejected(
      {
        'src/main.ts': `${APP}
          function defineCommand(cmd: { description: string }) {
            return { ...cmd, description: cmd.description + ' [shadow]' };
          }
          app.register({
            appId: 'd', name: 'D',
            commands: { go: defineCommand({ description: 'Go', handler: () => 1 }) },
          });`,
      },
      'commands.go',
    );
  });

  test('a locally-defined identity wrapper is still transparent', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const cmd = <T,>(d: T): T => d;
        app.register({
          appId: 'd', name: 'D',
          commands: { go: cmd({ description: 'Go', handler: () => 1 }) },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.go.description).toBe('Go');
  });

  test('deeply nested values are rejected, not a stack overflow', () => {
    // Deep enough to pass the evaluator's ceiling, shallow enough that
    // `ts.createSourceFile` still parses it — past that the parser itself
    // overflows, which `loadScope` reports separately.
    let params = `'leaf'`;
    for (let i = 0; i < 300; i++) params = `{ p: ${params} }`;

    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', params: ${params}, handler: () => 1 } },
        });`,
    });

    expect(protocol).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('nests deeper than');
  });

  test('a file the TypeScript parser cannot handle is reported, not thrown', () => {
    let params = `'leaf'`;
    for (let i = 0; i < 50_000; i++) params = `{ p: ${params} }`;

    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        app.register({ appId: 'd', name: 'D', commands: { go: { params: ${params} } } });`,
    });

    expect(protocol).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('could not be parsed');
    expect(errors[0].file).toBe('src/main.ts');
  });

  test('a spread of a call result is an error, not an omission', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          const build = () => ({ x: { description: 'X', handler: () => 1 } });
          app.register({ appId: 'd', name: 'D', commands: { ...build() } });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a descriptor map imported from a package cannot be resolved', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          import { vendorCommands } from 'some-package';
          app.register({ appId: 'd', name: 'D', commands: { ...vendorCommands } });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a missing description is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          app.register({ appId: 'd', name: 'D', commands: { silent: { handler: () => 1 } } });`,
      },
      'missing `description`',
    );
  });

  test('a computed description is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          const verb = 'Read';
          app.register({
            appId: 'd', name: 'D',
            commands: { go: { description: \`\${verb} things\`, handler: () => 1 } },
          });`,
      },
      'template literals',
    );
  });

  test('a method shorthand is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          app.register({
            appId: 'd', name: 'D',
            commands: { go() { return { description: 'G' }; } },
          });`,
      },
      'method shorthand',
    );
  });

  test('an unresolvable params schema is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${APP}
          declare const schema: object;
          app.register({
            appId: 'd', name: 'D',
            commands: { go: { description: 'G', params: schema, handler: () => 1 } },
          });`,
      },
      'commands.go.params',
    );
  });

  test('one bad entry rejects the whole manifest', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const build = () => ({});
        app.register({
          appId: 'd', name: 'D',
          commands: {
            good: { description: 'Good', handler: () => 1 },
            ...build(),
          },
        });`,
    });

    // A partial manifest is the failure mode, not a consolation prize.
    expect(protocol).toBeNull();
    expect(errors.length).toBe(1);
  });
});

// The runtime builds one flat lookup from names and aliases together, and the
// last registration wins. A duplicate therefore does not fail — it makes one
// command unreachable while the manifest keeps advertising both, so the agent
// calls a name that answers with the wrong handler.
describe('alias collisions', () => {
  test('two commands claiming the same alias is an error', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', aliases: ['go'], handler: () => 1 },
            navigate: { description: 'Navigate', aliases: ['go'], handler: () => 2 },
          },
        });`,
    });

    expect(protocol).toBeNull();
    const message = errors.map(formatProtocolError).join('\n');
    expect(message).toContain('`go` is already an alias of `open`');
    expect(message).toContain('unreachable');
  });

  test('an alias shadowing another command name is the same defect', () => {
    const { errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', handler: () => 1 },
            navigate: { description: 'Navigate', aliases: ['open'], handler: () => 2 },
          },
        });`,
    });

    expect(errors.map(formatProtocolError).join('\n')).toContain(
      '`open` is already command `open`',
    );
  });

  test('an alias equal to its own command name is still a collision', () => {
    const { errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'demo', name: 'Demo', state: {},
          commands: { open: { description: 'Open', aliases: ['open'], handler: () => 1 } },
        });`,
    });

    expect(errors).toHaveLength(1);
  });

  test('distinct aliases across commands are fine', () => {
    const { errors } = extract({
      'src/main.ts': `${APP}
        app.register({
          appId: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', aliases: ['o'], handler: () => 1 },
            navigate: { description: 'Navigate', aliases: ['n', 'go'], handler: () => 2 },
          },
        });`,
    });

    expect(errors).toEqual([]);
  });
});

describe('absence', () => {
  test('no register() call yields no protocol and no errors', () => {
    expect(extract({ 'src/main.ts': `document.title = 'x';` })).toMatchObject({
      protocol: null,
      errors: [],
    });
  });

  test('an unrelated .register() call is ignored', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `
        const Chart = { register(..._p: unknown[]): void {} };
        const registerables: unknown[] = [];
        Chart.register(...registerables);`,
    });

    expect(errors).toEqual([]);
    expect(protocol).toBeNull();
  });

  test('an unrelated .register({...}) does not shadow the real one', () => {
    // Both take object literals and neither receiver is named `app`, so the
    // registration has to be picked by shape, not by position.
    const { protocol, errors } = extract({
      'src/main.ts': `
        const plugin = { register(_c: unknown): void {} };
        plugin.register({ hooks: {} });
        const sdk = { register(_c: unknown): void {} };
        sdk.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', handler: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol?.commands ?? {})).toEqual(['go']);
  });

  test('two registration-shaped calls are ambiguous, not first-match', () => {
    // A store whose config happens to use `state`/`commands` passes the shape
    // gate too. Picking the first would silently discard the real protocol.
    const { protocol, errors } = extract({
      'src/main.ts': `
        const store = { register(_c: unknown): void {} };
        store.register({
          state: { count: { description: 'Count', handler: () => 0 } },
          commands: { reset: { description: 'Reset', handler: () => {} } },
        });
        const sdk = { register(_c: unknown): void {} };
        sdk.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', handler: () => 1 } },
        });`,
    });

    expect(protocol).toBeNull();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('ambiguous');
  });

  test('an `app`-receiver call always wins over a shaped bystander', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${APP}
        const store = { register(_c: unknown): void {} };
        store.register({ state: { count: { description: 'Count', handler: () => 0 } } });
        app.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', handler: () => 1 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['go']);
    expect(Object.keys(protocol!.state)).toEqual([]);
  });

  test('a missing entry file is not an error', () => {
    expect(extract({}, 'src/main.ts')).toMatchObject({ protocol: null, errors: [] });
  });

  test('an import cycle terminates', () => {
    const { errors } = extract({
      'src/a.ts': `import { b } from './b';\nexport const a = { ...b };`,
      'src/b.ts': `import { a } from './a';\nexport const b = { ...a };`,
      'src/main.ts': `${APP}
        import { a } from './a';
        app.register({ appId: 'd', name: 'D', commands: { ...a } });`,
    });

    // Whatever it decides, it must decide — not hang or overflow the stack.
    expect(Array.isArray(errors)).toBe(true);
  });
});
