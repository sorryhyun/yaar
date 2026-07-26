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
 * There is one registration shape, `export default defineApp({...})`, and one
 * reader. The text scanner this replaced is deleted; `app.register()` is removed
 * from the platform and is refused by name here rather than read (see the
 * `removed app.register()` block, and `extract-protocol-define-app.test.ts` for
 * the `defineApp`-specific rules).
 */
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { extractProtocolFromModules, formatProtocolError } from '../extract-protocol-ast.js';

/** Extract from an in-memory module map rooted at `src/main.ts`. */
function extract(files: Record<string, string>, entry = 'src/main.ts') {
  return extractProtocolFromModules(ts, entry, (path) => files[path] ?? null);
}

const IMPORT = `import { defineApp } from '@bundled/yaar';`;

describe('reach', () => {
  test('extracts a plain literal registration', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'demo',
          name: 'Demo',
          state: { status: { description: 'Status', get: () => 'ok' } },
          commands: {
            ping: {
              description: 'Ping',
              aliases: ['p'],
              params: { type: 'object', properties: { n: { type: 'number' } } },
              returns: { type: 'string' },
              run: () => 'pong',
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
          readFile: { description: 'Read', run: () => '' },
        };`,
      'src/commands/git.ts': `
        export const gitCommands = { commit: { description: 'Commit', run: () => '' } };`,
      'src/main.ts': `${IMPORT}
        import { fileCommands } from './commands/files';
        export default defineApp({ id: 'd', name: 'D', commands: { ...fileCommands } });`,
    });

    expect(errors).toEqual([]);
    // Nested spread first, matching source order.
    expect(Object.keys(protocol!.commands)).toEqual(['commit', 'readFile']);
  });

  test('a whole section may be an imported const', () => {
    const { protocol, errors } = extract({
      'src/state.ts': `export const appState = { a: { description: 'A', get: () => 1 } };`,
      'src/main.ts': `${IMPORT}
        import { appState } from './state';
        export default defineApp({ id: 'd', name: 'D', state: appState });`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.state)).toEqual(['a']);
  });

  test('sees through defineAppCommand and other single-argument wrappers', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        const defineAppCommand = <T,>(d: T): T => d;
        export default defineApp({
          id: 'd', name: 'D',
          commands: { ping: defineAppCommand({ description: 'Ping', run: () => 1 }) },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Ping');
  });

  test('joins `+`-concatenated strings, including inside params', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd', name: 'D',
          commands: {
            go: {
              description: 'One ' + 'two ' + 'three',
              params: {
                type: 'object',
                properties: { mode: { description: 'a ' + 'b', type: 'string' } },
              },
              run: () => 1,
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
      'src/main.ts': `${IMPORT}
        const pingCommand = { description: 'Ping', run: () => 1 } as const;
        export default defineApp({ id: 'd', name: 'D', commands: { ping: pingCommand } });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Ping');
  });

  test('later keys win, as they do at runtime', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        const base = { ping: { description: 'Base', run: () => 1 } };
        export default defineApp({
          id: 'd', name: 'D',
          commands: { ...base, ping: { description: 'Override', run: () => 2 } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.ping.description).toBe('Override');
  });

  test('the config may be a const declared in another module', () => {
    const { protocol, errors } = extract({
      'src/config.ts': `
        export const config = {
          id: 'd', name: 'D',
          commands: { ping: { description: 'P', run: () => 1 } },
        };`,
      'src/main.ts': `${IMPORT}
        import { config } from './config';
        export default defineApp(config);`,
    });

    expect(errors).toEqual([]);
    expect(Object.keys(protocol!.commands)).toEqual(['ping']);
  });

  test('the built-in `manifest` state key is not re-declared', () => {
    const { protocol } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd', name: 'D',
          state: {
            manifest: { description: 'Built in', get: () => null },
            real: { description: 'Real', get: () => 1 },
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

  test('a destructured binding is refused, not read as some other `cmds`', () => {
    // Only a `const` with a readable initializer resolves. A binding the
    // extractor cannot read must be an error rather than fall back to a
    // same-named one elsewhere — that fallback is the one failure this extractor
    // may not have, since it produces a manifest that disagrees with the runtime
    // and says nothing about it.
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          declare const source: { cmds: Record<string, unknown> };
          const { cmds } = source;
          export default defineApp({ id: 'd', name: 'D', commands: { ...cmds } });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a `let` is not read as its initializer', () => {
    // `refresh()` reassigns it before the app registers, so the initializer is
    // not the value the runtime serves. Reporting it would be a silent lie.
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          let description = 'initial';
          function refresh() { description = 'actual'; }
          refresh();
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description, run: () => 1 } },
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
        'src/main.ts': `${IMPORT}
          function withDeprecation(cmd: { description: string }) {
            return { ...cmd, description: cmd.description + ' (deprecated)' };
          }
          export default defineApp({
            id: 'd', name: 'D',
            commands: { old: withDeprecation({ description: 'Old cmd', run: () => 1 }) },
          });`,
      },
      'commands.old',
    );
  });

  test('a locally-declared non-identity `defineAppCommand` is not trusted by name', () => {
    // The SDK's `defineAppCommand` is trusted because it is imported from a
    // package and documented as identity. A function of the same name declared
    // *here* is just a function, and stepping over it would report 'Go' while
    // the runtime registers 'Go [shadow]'.
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          function defineAppCommand(cmd: { description: string }) {
            return { ...cmd, description: cmd.description + ' [shadow]' };
          }
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: defineAppCommand({ description: 'Go', run: () => 1 }) },
          });`,
      },
      'commands.go',
    );
  });

  test('a locally-defined identity wrapper is still transparent', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        const cmd = <T,>(d: T): T => d;
        export default defineApp({
          id: 'd', name: 'D',
          commands: { go: cmd({ description: 'Go', run: () => 1 }) },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol!.commands.go.description).toBe('Go');
  });

  test('deeply nested values are rejected, not a stack overflow', () => {
    // Deep enough to pass the evaluator's ceiling, shallow enough that
    // `ts.createSourceFile` still parses it — past that the parser itself
    // overflows, which `loadScope` reports separately. `aliases` rather than
    // `params`, because a `params` the evaluator cannot fold is deferred to the
    // schema fold rather than refused outright (see below).
    let aliases = `'leaf'`;
    for (let i = 0; i < 300; i++) aliases = `[${aliases}]`;

    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'd', name: 'D',
          commands: { go: { description: 'Go', aliases: ${aliases}, run: () => 1 } },
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
      'src/main.ts': `${IMPORT}
        export default defineApp({ id: 'd', name: 'D', commands: { go: { params: ${params} } } });`,
    });

    expect(protocol).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('could not be parsed');
    expect(errors[0].file).toBe('src/main.ts');
  });

  test('a spread of a call result is an error, not an omission', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          const build = () => ({ x: { description: 'X', run: () => 1 } });
          export default defineApp({ id: 'd', name: 'D', commands: { ...build() } });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a descriptor map imported from a package cannot be resolved', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          import { vendorCommands } from 'some-package';
          export default defineApp({ id: 'd', name: 'D', commands: { ...vendorCommands } });`,
      },
      'spread source could not be resolved',
    );
  });

  test('a missing description is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          export default defineApp({ id: 'd', name: 'D', commands: { silent: { run: () => 1 } } });`,
      },
      'missing `description`',
    );
  });

  test('a computed description is an error', () => {
    expectRejected(
      {
        'src/main.ts': `${IMPORT}
          const verb = 'Read';
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: \`\${verb} things\`, run: () => 1 } },
          });`,
      },
      'template literals',
    );
  });

  test('a params schema the evaluator cannot fold is deferred, never dropped', () => {
    // The one construct that is *not* refused: `z.object({...})` is a builder
    // chain, so a static evaluator can only report it as unresolvable. The path
    // is recorded instead, and `fold-schemas.ts` reads it off the running app —
    // which either produces the schema or fails the build naming this same path.
    const { protocol, errors, pendingFolds } = extract({
      'src/main.ts': `${IMPORT}
          declare const schema: object;
          export default defineApp({
            id: 'd', name: 'D',
            commands: { go: { description: 'G', params: schema, run: () => 1 } },
          });`,
    });

    expect(errors).toEqual([]);
    expect(pendingFolds).toEqual(['commands.go.params']);
    expect(protocol!.commands.go.params).toBeUndefined();
  });

  test('one bad entry rejects the whole manifest', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        const build = () => ({});
        export default defineApp({
          id: 'd', name: 'D',
          commands: {
            good: { description: 'Good', run: () => 1 },
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
// last entry wins. A duplicate therefore does not fail — it makes one command
// unreachable while the manifest keeps advertising both, so the agent calls a
// name that answers with the wrong handler.
describe('alias collisions', () => {
  test('two commands claiming the same alias is an error', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', aliases: ['go'], run: () => 1 },
            navigate: { description: 'Navigate', aliases: ['go'], run: () => 2 },
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
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', run: () => 1 },
            navigate: { description: 'Navigate', aliases: ['open'], run: () => 2 },
          },
        });`,
    });

    expect(errors.map(formatProtocolError).join('\n')).toContain(
      '`open` is already command `open`',
    );
  });

  test('an alias equal to its own command name is still a collision', () => {
    const { errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'demo', name: 'Demo', state: {},
          commands: { open: { description: 'Open', aliases: ['open'], run: () => 1 } },
        });`,
    });

    expect(errors).toHaveLength(1);
  });

  test('distinct aliases across commands are fine', () => {
    const { errors } = extract({
      'src/main.ts': `${IMPORT}
        export default defineApp({
          id: 'demo', name: 'Demo', state: {},
          commands: {
            open: { description: 'Open', aliases: ['o'], run: () => 1 },
            navigate: { description: 'Navigate', aliases: ['n', 'go'], run: () => 2 },
          },
        });`,
    });

    expect(errors).toEqual([]);
  });
});

// `app.register()` is gone from the runtime. An app still calling it would
// otherwise extract to *no protocol at all* and build green with every command
// missing from the manifest — the exact silent truncation this module exists to
// prevent — so it is refused by name, with the migration in the message.
describe('removed app.register()', () => {
  test('an app.register() call is refused with the migration named', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `
        const app = { register(_c: unknown): void {} };
        app.register({
          appId: 'd', name: 'D',
          commands: { go: { description: 'Go', handler: () => 1 } },
        });`,
    });

    expect(protocol).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('`app.register({...})` has been removed');
    expect(errors[0].message).toContain('defineApp');
    expect(errors[0].file).toBe('src/main.ts');
  });

  test('a register() call in any module is caught, not just the entry', () => {
    const { errors } = extract({
      'src/protocol.ts': `
        const app = { register(_c: unknown): void {} };
        export function registerProtocol() {
          app.register({ appId: 'd', name: 'D', commands: {} });
        }`,
      'src/main.ts': `import { registerProtocol } from './protocol';\nregisterProtocol();`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('src/protocol.ts');
  });

  test('it wins over a defineApp in the same app, since only one can run', () => {
    const { protocol, errors } = extract({
      'src/main.ts': `${IMPORT}
        const app = { register(_c: unknown): void {} };
        app.register({ appId: 'd', name: 'D', commands: {} });
        export default defineApp({
          id: 'd', name: 'D',
          commands: { go: { description: 'Go', run: () => 1 } },
        });`,
    });

    expect(protocol).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('has been removed');
  });

  test('an unrelated .register() call is not mistaken for one', () => {
    // `Chart.register(...registerables)` ships in a bundled app today.
    const { protocol, errors } = extract({
      'src/main.ts': `
        const Chart = { register(..._p: unknown[]): void {} };
        const registerables: unknown[] = [];
        Chart.register(...registerables);`,
    });

    expect(errors).toEqual([]);
    expect(protocol).toBeNull();
  });

  test('a registration-shaped call on a non-`app` receiver is left alone', () => {
    // A store whose config happens to use `state`/`commands` is not this app's
    // registration, and never was — the receiver is what decides.
    const { protocol, errors } = extract({
      'src/main.ts': `
        const store = { register(_c: unknown): void {} };
        store.register({
          state: { count: { description: 'Count', handler: () => 0 } },
          commands: { reset: { description: 'Reset', handler: () => {} } },
        });`,
    });

    expect(errors).toEqual([]);
    expect(protocol).toBeNull();
  });
});

describe('absence', () => {
  test('no registration yields no protocol and no errors', () => {
    expect(extract({ 'src/main.ts': `document.title = 'x';` })).toMatchObject({
      protocol: null,
      errors: [],
    });
  });

  test('a missing entry file is not an error', () => {
    expect(extract({}, 'src/main.ts')).toMatchObject({ protocol: null, errors: [] });
  });

  test('an import cycle terminates', () => {
    const { errors } = extract({
      'src/a.ts': `import { b } from './b';\nexport const a = { ...b };`,
      'src/b.ts': `import { a } from './a';\nexport const b = { ...a };`,
      'src/main.ts': `${IMPORT}
        import { a } from './a';
        export default defineApp({ id: 'd', name: 'D', commands: { ...a } });`,
    });

    // Whatever it decides, it must decide — not hang or overflow the stack.
    expect(Array.isArray(errors)).toBe(true);
  });
});
