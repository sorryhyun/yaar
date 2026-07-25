/**
 * Zod schemas reach the manifest by running the app.
 *
 * `params: z.object({...})` is not a compile-time constant, so the AST evaluator
 * can only ever report it as unresolvable. `fold-schemas.ts` builds the app with
 * a fold entry and asks the running definition what its schemas are — which is
 * the same object the iframe will serve, so the manifest cannot drift from it.
 *
 * The invariant under test is the one the extractor exists for, unchanged: a
 * schema that works at runtime is visible in `dist/protocol.json`, or the build
 * fails naming the descriptor. There is no third outcome, and every case below
 * is an assertion about which of the two happened.
 *
 * These are real `Bun.build()`s plus a real Worker per case; the suite is slow on
 * purpose, because a fold that works against a mock proves nothing about the
 * `@bundled/yaar` barrel reaching `window.yaar` at module scope.
 */
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { compileTypeScript } from '../compile.js';
import { initCompiler } from '../config.js';
import { extractProtocolFromDir } from '../extract-protocol-dir.js';

setDefaultTimeout(60_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let appDir: string | null = null;

afterEach(async () => {
  if (appDir) await rm(appDir, { recursive: true, force: true });
  appDir = null;
  delete process.env.YAAR_NO_TYPESCRIPT;
});

/** Lay out a real app directory — the fold needs one on disk to build from. */
async function writeApp(files: Record<string, string>, appId = 'folder') {
  appDir = await mkdtemp(join(tmpdir(), 'yaar-fold-'));
  await mkdir(join(appDir, 'src'), { recursive: true });
  await Bun.write(join(appDir, 'app.json'), JSON.stringify({ appId, name: 'Folder' }));
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(appDir, rel), content);
  }
  return appDir;
}

async function compileApp(files: Record<string, string>, appId = 'folder') {
  return compileTypeScript(await writeApp(files, appId), { title: 'Fold' });
}

async function readProtocol(): Promise<Record<string, any>> {
  return JSON.parse(await Bun.file(join(appDir!, 'dist', 'protocol.json')).text());
}

const HEAD = `import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
`;

describe('a Zod schema reaches the manifest', () => {
  test('params fold to JSON Schema, alongside literal params left untouched', async () => {
    const result = await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            add: {
              description: 'Add a memo',
              params: z.object({ text: z.string(), pinned: z.optional(z.boolean()) }),
              run: (p) => p.text.length,
            },
            ping: {
              description: 'Ping',
              params: { type: 'object', properties: {}, additionalProperties: true },
              run: () => 'pong',
            },
          },
        });`,
    });

    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const protocol = await readProtocol();
    expect(protocol.commands.add.params).toEqual({
      type: 'object',
      properties: { text: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['text'],
    });
    // A per-entry `$schema` is noise in the agent's context; the descriptor is an
    // inline subschema, not a document.
    expect('$schema' in protocol.commands.add.params).toBe(false);
    // Untouched: only the paths the evaluator deferred come from the fold.
    expect(protocol.commands.ping.params).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
  });

  test('the compiled HTML hands the folded manifest back to the running app', async () => {
    // Without it the SDK would serve a Zod schema object to agents as though it
    // were the contract: the app holds the parser, the build holds the JSON.
    await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            add: { description: 'Add', params: z.object({ text: z.string() }), run: () => 1 },
          },
        });`,
    });

    const html = await Bun.file(join(appDir!, 'dist', 'index.html')).text();
    const injected = html.match(/window\.__yaar_manifest__=(.*?);<\/script>/);
    expect(injected).not.toBeNull();
    expect(JSON.parse(injected![1])).toEqual(await readProtocol());
  });

  test('state schemas and returns fold too', async () => {
    await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          state: {
            doc: { description: 'The document', schema: z.object({ title: z.string() }), get: () => ({ title: 'x' }) },
          },
          commands: {
            save: { description: 'Save', returns: z.object({ ok: z.boolean() }), run: () => ({ ok: true }) },
          },
        });`,
    });

    const protocol = await readProtocol();
    expect(protocol.state.doc.schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(protocol.commands.save.returns.properties.ok).toEqual({ type: 'boolean' });
  });

  test('a quoted command name containing a dot still finds its schema', async () => {
    // The fold is addressed by path (`commands.<key>.params`), and a naive
    // three-way split would look up a command that does not exist here and
    // report the schema as unfoldable.
    await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            'current.path': { description: 'Where', params: z.object({ p: z.string() }), run: () => 1 },
          },
        });`,
    });

    const protocol = await readProtocol();
    expect(protocol.commands['current.path'].params.properties.p).toEqual({ type: 'string' });
  });

  test('a schema built in another module folds, like every other descriptor value', async () => {
    // The reach that lets a protocol be split by domain has to survive the fold;
    // otherwise adopting Zod would quietly forbid the decomposition.
    await compileApp({
      'src/schemas.ts': `import * as z from '@bundled/zod';
        export const AddParams = z.object({ text: z.string() });`,
      'src/main.ts': `import { defineApp } from '@bundled/yaar';
        import { AddParams } from './schemas';
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: { add: { description: 'Add', params: AddParams, run: () => 1 } },
        });`,
    });

    const protocol = await readProtocol();
    expect(protocol.commands.add.params.properties.text).toEqual({ type: 'string' });
  });
});

describe('a fold that cannot answer fails the build', () => {
  test('a schema with no JSON Schema equivalent names the descriptor', async () => {
    const result = await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            at: { description: 'At', params: z.object({ when: z.date() }), run: () => 1 },
          },
        });`,
    });

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('commands.at.params');
    expect(errors).toContain('Date');
    expect(await Bun.file(join(appDir!, 'dist', 'protocol.json')).exists()).toBe(false);
  });

  test('an app that throws while importing reports the deferred paths', async () => {
    // "the app threw" alone would leave the author with no way to connect the
    // failure to the `z.object(...)` they just wrote.
    const result = await compileApp({
      'src/main.ts': `${HEAD}
        const missing = (null as unknown as { gone: () => void });
        missing.gone();
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            add: { description: 'Add', params: z.object({ t: z.string() }), run: () => 1 },
          },
        });`,
    });

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('commands.add.params');
    expect(errors).toContain('threw while being imported');
  });

  test('a non-constant schema in an app.register() app is still a hard error', async () => {
    // No default export to read a schema back off, so there is nothing to defer
    // to — the refusal has to stay where it was.
    const result = await compileApp({
      'src/main.ts': `import { app } from '@bundled/yaar';
        import * as z from '@bundled/zod';
        app.register({
          appId: 'folder',
          name: 'Folder',
          state: {},
          commands: {
            add: { description: 'Add', params: z.object({ t: z.string() }), handler: () => 1 },
          },
        });`,
    });

    expect(result.success).toBe(false);
    expect((result.errors ?? []).join('\n')).toContain('commands.add.params');
  });
});

describe('without typescript, the running app is the manifest', () => {
  const MAIN = `${HEAD}
    export default defineApp({
      id: 'folder',
      name: 'Folder',
      state: { count: { description: 'How many', get: () => 1 } },
      commands: {
        add: {
          description: 'Add a memo',
          aliases: ['create'],
          replay: 'never',
          params: z.object({ text: z.string() }),
          run: () => 1,
        },
      },
      events: { added: { description: 'A memo landed' } },
    });`;

  test('a defineApp app extracts through the fold instead of being refused', async () => {
    // The bundled exe has no AST extractor. Refusing there reported "declares no
    // protocol" for an app full of commands — true-sounding and wrong about
    // every one of them.
    const dir = await writeApp({ 'src/main.ts': MAIN });
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.errors).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.protocol!.commands.add).toEqual({
      description: 'Add a memo',
      aliases: ['create'],
      replay: 'never',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    });
    expect(result.protocol!.state.count).toEqual({ description: 'How many' });
    expect(result.protocol!.events).toEqual({ added: { description: 'A memo landed' } });
  });

  test('the app.json id check survives the loss of the AST path', async () => {
    const dir = await writeApp({ 'src/main.ts': MAIN }, 'somethingElse');
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.protocol).toBeNull();
    expect(result.errors.map((e) => e.message).join('\n')).toContain('somethingElse');
  });

  test('the same app extracts identically with and without typescript', async () => {
    // Two extractors that disagree is the drift this pass exists to remove; the
    // fold is only an acceptable second reader if it is not a second answer.
    const dir = await writeApp({ 'src/main.ts': MAIN });
    const withAst = await extractProtocolFromDir(join(dir, 'src'));
    process.env.YAAR_NO_TYPESCRIPT = '1';
    const withoutAst = await extractProtocolFromDir(join(dir, 'src'));

    expect(withAst.errors).toEqual([]);
    expect(withoutAst.protocol).toEqual(withAst.protocol);
  });
});
