/**
 * A compile refuses to ship a truncated protocol manifest.
 *
 * The rule is one-sided: an entry that works at runtime must be visible in
 * dist/protocol.json, because a command an agent cannot see does not exist. So
 * the gate fails the build on anything the extractor cannot resolve rather than
 * writing a manifest it had to guess around.
 *
 * What counts as resolvable widened when extraction moved to the TypeScript AST.
 * A spread of a descriptor map — including one imported from another file — is
 * now followed, which is what lets a large protocol.ts be split by domain. A
 * spread of a *call result* still cannot be resolved, and that is the case the
 * gate exists for.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';

// Each case pays for a real Bun.build().
setDefaultTimeout(30_000);

beforeAll(() => {
  initCompiler({
    projectRoot: resolve(import.meta.dir, '../../../..'),
    isBundledExe: false,
  });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

/** Write `files` (relative to the sandbox) and compile. */
async function compileFiles(files: Record<string, string>) {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-protocol-gate-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(sandbox, rel), content);
  }
  return compileTypeScript(sandbox, { title: 'Gate Test' });
}

async function compileSource(source: string) {
  return compileFiles({ 'src/main.ts': source });
}

// A local stand-in for app.register — a @bundled import would drag the whole SDK
// into the test. The binding must still be named `app`: the extractor looks for
// the SDK's app object specifically, so an unrelated `Chart.register(...)` in a
// real app is not mistaken for a protocol registration.
const PRELUDE = `
const app = { register(_config: unknown): void {} };
const sharedCommands = { extra: { description: 'Extra', handler: () => 0 } };
void sharedCommands;
`;

const SPREAD = `${PRELUDE}
app.register({
  appId: 'demo',
  name: 'Demo',
  commands: {
    first: { description: 'First', handler: () => 1 },
    ...sharedCommands,
    third: { description: 'Third', handler: () => 3 },
  },
});
export {};
`;

const UNRESOLVABLE = `${PRELUDE}
function buildCommands() {
  return { generated: { description: 'Generated', handler: () => 0 } };
}
app.register({
  appId: 'demo',
  name: 'Demo',
  commands: {
    first: { description: 'First', handler: () => 1 },
    ...buildCommands(),
  },
});
export {};
`;

const NO_DESCRIPTION = `${PRELUDE}
app.register({
  appId: 'demo',
  name: 'Demo',
  commands: {
    silent: { handler: () => 1 },
  },
});
export {};
`;

const CLEAN = `${PRELUDE}
app.register({
  appId: 'demo',
  name: 'Demo',
  state: {
    status: { description: 'Status', handler: () => 'ok' },
  },
  commands: {
    first: { description: 'First', handler: () => 1 },
    third: { description: 'Third', handler: () => 3 },
  },
});
export {};
`;

describe('compile protocol gate', () => {
  test('a spread of a local descriptor map lands in the manifest', async () => {
    const result = await compileFiles({ 'src/main.ts': SPREAD });

    expect(result.success).toBe(true);
    // `extra` is the entry the old text scanner stopped at and dropped.
    expect(result.protocol?.commands).toEqual(['first', 'extra', 'third']);

    const written = JSON.parse(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).text());
    expect(Object.keys(written.commands)).toEqual(['first', 'extra', 'third']);
    expect(written.commands.extra.description).toBe('Extra');
  });

  test('descriptor maps may live in another file', async () => {
    const result = await compileFiles({
      'src/commands/files.ts': `
        export const fileCommands = {
          readFile: {
            description: 'Read a file from disk, ' + 'returning its text',
            params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            handler: (_p: { path: string }) => '',
          },
        };
      `,
      'src/main.ts': `
        const app = { register(_config: unknown): void {} };
        import { fileCommands } from './commands/files';
        app.register({
          appId: 'demo',
          name: 'Demo',
          commands: { ...fileCommands, ping: { description: 'Ping', handler: () => 'pong' } },
        });
        export {};
      `,
    });

    expect(result.success).toBe(true);
    expect(result.protocol?.commands).toEqual(['readFile', 'ping']);

    const written = JSON.parse(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).text());
    // The `+`-concatenated description is joined, and the params schema — which
    // the text scanner dropped whenever the block held a concatenation — survives.
    expect(written.commands.readFile.description).toBe('Read a file from disk, returning its text');
    expect(written.commands.readFile.params).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  test('fails the build when a spread cannot be resolved', async () => {
    const result = await compileSource(UNRESOLVABLE);

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('spread');
    expect(errors).toContain('commands');
    // The location is what makes the refusal actionable.
    expect(errors).toMatch(/src\/main\.ts:\d+:\d+/);

    // The truncated manifest must not have been written.
    expect(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).exists()).toBe(false);
  });

  test('fails the build when a descriptor has no description', async () => {
    const result = await compileSource(NO_DESCRIPTION);

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('commands.silent');
    expect(errors).toContain('description');
    expect(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).exists()).toBe(false);
  });

  test('a clean register() compiles and reports the manifest summary', async () => {
    const result = await compileSource(CLEAN);

    expect(result.success).toBe(true);
    expect(result.protocol).toEqual({ commands: ['first', 'third'], state: ['status'] });

    const written = JSON.parse(await Bun.file(join(sandbox!, 'dist', 'protocol.json')).text());
    expect(Object.keys(written.commands)).toEqual(['first', 'third']);
  });

  test('no register() call compiles with no protocol summary', async () => {
    const result = await compileSource(`document.title = 'plain';\nexport {};\n`);

    expect(result.success).toBe(true);
    expect(result.protocol).toBeUndefined();
  });

  test('an unrelated .register() call is not mistaken for the protocol', async () => {
    const result = await compileSource(`
      const Chart = { register(..._parts: unknown[]): void {} };
      const registerables = [1, 2, 3];
      Chart.register(...registerables);
      const app = { register(_config: unknown): void {} };
      app.register({
        appId: 'demo',
        name: 'Demo',
        commands: { ping: { description: 'Ping', handler: () => 'pong' } },
      });
      export {};
    `);

    expect(result.success).toBe(true);
    expect(result.protocol?.commands).toEqual(['ping']);
  });
});
