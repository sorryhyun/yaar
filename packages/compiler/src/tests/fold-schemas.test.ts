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
import { extractProtocolFromDir } from '../protocol/extract-protocol-dir.js';
import { explainImportFailure } from '../protocol/fold-schemas.js';

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

describe('a shape stated more than once reaches the manifest once', () => {
  // Two halves of one behavior: zod's `reused: 'ref'` shares a schema *instance*
  // within a descriptor, and `dedupe-schemas.ts` shares an identical shape across
  // descriptors and promotes zod's descriptor-local `$defs` to the manifest — where
  // its `#/$defs/...` pointers actually resolve.
  const SLOT = `const slot = z.object({
      uri: z.string(),
      repeat: z.optional(z.number()),
      offset: z.optional(z.number()),
      rotation: z.optional(z.number()),
      center: z.optional(z.number()),
      wrapS: z.optional(z.string()),
    });`;

  test('one Zod const used five times is one $defs entry and five pointers', async () => {
    const result = await compileApp({
      'src/main.ts': `${HEAD}
        ${SLOT}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            setMaterial: {
              description: 'Set material maps',
              params: z.object({ id: z.string(), map: slot, alphaMap: slot, normalMap: slot }),
              run: () => 1,
            },
            setDecal: {
              description: 'Set a decal',
              params: z.object({ id: z.string(), map: slot }),
              run: () => 1,
            },
          },
        });`,
    });

    expect(result.errors ?? []).toEqual([]);
    const protocol = await readProtocol();

    // The manifest is the schema document, so the table lives on it and not inside
    // one descriptor — a `$defs` left on `params` would point at the wrong root.
    expect(Object.keys(protocol.$defs)).toHaveLength(1);
    const name = Object.keys(protocol.$defs)[0];
    expect(name).not.toContain('__schema');
    const ref = { $ref: `#/$defs/${name}` };
    expect(protocol.commands.setMaterial.params.properties.map).toEqual(ref);
    expect(protocol.commands.setMaterial.params.properties.alphaMap).toEqual(ref);
    expect(protocol.commands.setDecal.params.properties.map).toEqual(ref);
    expect('$defs' in protocol.commands.setMaterial.params).toBe(false);
    // Nothing is lost: the shape is still stated, once.
    expect(protocol.$defs[name].properties.uri).toEqual({ type: 'string' });
    expect(protocol.$defs[name].required).toEqual(['uri']);
    // The top-level params keeps `properties`/`required` — the iframe bridge and
    // `renderSignature` both read them straight off it.
    expect(protocol.commands.setMaterial.params.required).toEqual([
      'id',
      'map',
      'alphaMap',
      'normalMap',
    ]);
  });

  test('the folded manifest handed back to the app carries the table', async () => {
    // The SDK serves the manifest from these bytes; without `$defs` every agent-facing
    // schema would be full of pointers into nothing.
    await compileApp({
      'src/main.ts': `${HEAD}
        ${SLOT}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            a: { description: 'A', params: z.object({ map: slot, alt: slot }), run: () => 1 },
          },
        });`,
    });

    const html = await Bun.file(join(appDir!, 'dist', 'index.html')).text();
    const injected = html.match(/window\.__yaar_manifest__=(.*?);<\/script>/);
    const manifest = JSON.parse(injected![1]);
    expect(manifest).toEqual(await readProtocol());
    expect(Object.keys(manifest.$defs)).toHaveLength(1);
  });

  test('an app that hand-writes the same JSON Schema twice is folded too', async () => {
    // The pass runs after extraction, not inside the fold, so a JSON-literal app —
    // which never reaches the fold at all — gets the same treatment.
    const result = await compileApp({
      'src/main.ts': `import { defineApp } from '@bundled/yaar';
        const point = {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X in world units' },
            y: { type: 'number', description: 'Y in world units' },
            z: { type: 'number', description: 'Z in world units' },
          },
          required: ['x', 'y', 'z'],
        };
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            move: {
              description: 'Move',
              params: { type: 'object', properties: { from: point, to: point } },
              run: () => 1,
            },
          },
        });`,
    });

    expect(result.errors ?? []).toEqual([]);
    const protocol = await readProtocol();
    expect(protocol.$defs.x_y_z.required).toEqual(['x', 'y', 'z']);
    expect(protocol.commands.move.params.properties.from).toEqual({ $ref: '#/$defs/x_y_z' });
    expect(protocol.commands.move.params.properties.to).toEqual({ $ref: '#/$defs/x_y_z' });
  });

  test('an app that shares nothing gains no $defs key', async () => {
    await compileApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: { add: { description: 'Add', params: z.object({ t: z.string() }), run: () => 1 } },
        });`,
    });
    expect('$defs' in (await readProtocol())).toBe(false);
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

  test('a module-scope solid-js/html template is named as the cause, not left as a stack', async () => {
    // The failure this whole hint exists for: `html` compiles its template on
    // import, the fold's DOM is a stub, and what the author used to get was
    // eight lines of bundled Solid internals at a worker.mjs line number.
    const result = await compileApp({
      'src/main.ts': `${HEAD}import html from '@bundled/solid-js/html';
        const view = html\`<div><span>hi</span></div>\`;
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: {
            add: { description: 'Add', params: z.object({ t: z.string() }), run: () => 1 },
          },
          view: { mount: (el: HTMLElement) => el.appendChild(view as Node) },
        });`,
    });

    expect(result.success).toBe(false);
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('commands.add.params');
    expect(errors).toContain('@bundled/solid-js/html at module scope');
    expect(errors).toContain('JSON Schema literal');
    // The stack still ships, after the diagnosis — it is the evidence for it.
    expect(errors).toContain('at createTemplate');
  });

  test('an unrelated import failure keeps the generic message', () => {
    // The hint tests for Solid's own frame, so an app whose own module scope
    // throws is not told to rewrite a template it never wrote.
    expect(explainImportFailure('TypeError: missing.gone is not a function\n  at main.ts:3')).toBe(
      null,
    );
  });

  test('an app.register() app is refused before any schema is folded', async () => {
    // `register()` is gone from the runtime, so there is no deferral to attempt:
    // the build stops at the call itself, naming the migration.
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
    const errors = (result.errors ?? []).join('\n');
    expect(errors).toContain('`app.register({...})` has been removed');
    expect(errors).toContain('defineApp');
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
      keybindings: { 'Ctrl+Enter': 'add' },
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
    expect(result.protocol!.keybindings).toEqual({ 'Ctrl+Enter': 'add' });
  });

  test('a keybinding bound to an unknown command is refused without typescript too', async () => {
    // The semantic checks live in @yaar/shared precisely so this path cannot
    // accept a binding the AST path would reject.
    const dir = await writeApp({
      'src/main.ts': `${HEAD}
        export default defineApp({
          id: 'folder',
          name: 'Folder',
          commands: { add: { description: 'Add', run: () => 1 } },
          keybindings: { ArrowUp: 'missing' },
        });`,
    });
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.protocol).toBeNull();
    expect(result.errors.map((e) => e.message).join('\n')).toContain('not a declared command');
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

  test('the $defs table is the same on both roads, names included', async () => {
    // The AST road folds Zod per descriptor and then dedups; the no-typescript road
    // reads the whole manifest off the running app and dedups the same way. A def
    // named differently on the two would make every deploy of the same source look
    // like a protocol change (`deploy.ts` diffs them).
    const shared = `${HEAD}
      const slot = z.object({
        uri: z.string(),
        repeat: z.optional(z.number()),
        offset: z.optional(z.number()),
        rotation: z.optional(z.number()),
        center: z.optional(z.number()),
      });
      export default defineApp({
        id: 'folder',
        name: 'Folder',
        commands: {
          setMaterial: { description: 'Set', params: z.object({ map: slot, alphaMap: slot }), run: () => 1 },
          setDecal: { description: 'Decal', params: z.object({ map: slot }), run: () => 1 },
        },
      });`;
    const dir = await writeApp({ 'src/main.ts': shared });
    const withAst = await extractProtocolFromDir(join(dir, 'src'));
    process.env.YAAR_NO_TYPESCRIPT = '1';
    const withoutAst = await extractProtocolFromDir(join(dir, 'src'));

    expect(withAst.errors).toEqual([]);
    expect(Object.keys(withAst.protocol!.$defs ?? {})).toHaveLength(1);
    expect(withoutAst.protocol).toEqual(withAst.protocol);
  });

  test('an app.register() app is refused here too, not silently emptied', async () => {
    // Without the AST there is no extractor to refuse the call, and the fold
    // cannot stand in for it either — an app.register() app does its UI setup at
    // module scope, which a headless import cannot run. A text scan for the call
    // is what keeps this environment's answer the same as the AST path's: the
    // one answer it must never give is silence. (It gave exactly that once: the
    // brace-matching scanner that used to *read* protocols here returned nothing
    // at all for the two bundled apps splitting descriptor maps across files —
    // devtools, 28 commands; video-editor-lite, 19 — with neither error nor
    // warning.)
    const dir = await writeApp({
      'src/main.ts': `import { app } from '@bundled/yaar';
        app.register({
          appId: 'folder',
          commands: { add: { description: 'Add a memo', handler: () => 1 } },
          state: {},
        });`,
    });
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.protocol).toBeNull();
    const message = result.errors.map((e) => e.message).join('\n');
    expect(message).toContain('`app.register({...})` has been removed');
    expect(message).toContain('defineApp');
  });

  test("an app's own object named `app` is left alone here too", async () => {
    // The AST path resolves the receiver to the SDK's `app`; with no typescript
    // to resolve with, the import is the proxy. Both readers must answer alike,
    // and neither may fail a build over a local object that shares the name.
    const dir = await writeApp({
      'src/main.ts': `const registry = { register(_c: unknown): void {} };
        const app = registry;
        app.register({ hooks: {} });
        export {};\n`,
    });
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.errors).toEqual([]);
  });

  test('an app that registers nothing still extracts cleanly', async () => {
    // Most apps only draw a UI. Turning "declares no protocol" into a build
    // error would be the refusal above misfiring on every one of them.
    const dir = await writeApp({ 'src/main.ts': `document.title = 'plain';\nexport {};\n` });
    process.env.YAAR_NO_TYPESCRIPT = '1';

    const result = await extractProtocolFromDir(join(dir, 'src'));

    expect(result.protocol).toBeNull();
    expect(result.errors).toEqual([]);
  });
});
