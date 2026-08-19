/**
 * What happens to a binary an app `import`s.
 *
 * A YAAR app is one self-contained HTML file, so an imported asset has exactly
 * two possible fates: inlined as a `data:` URI, or emitted by Bun's default
 * `file` loader as a sibling the server never serves. The second one used to be
 * reported as `built: true` — a `.glb` import compiled green and the app 403'd at
 * runtime fetching `./level01-1qzm5cr8.glb`, a failure with no visible link back
 * to the import that caused it.
 *
 * These cases pin both halves: the extensions that inline, and the build refusal
 * for everything else.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { typecheckSandbox } from '../typecheck.js';
import { ASSET_MIME_TYPES } from '../bundled/plugins.js';
import { siblingAssetError } from '../build/build-app.js';
import { BUNDLED_TYPES_DTS } from '../paths.js';

// Each case pays for a real Bun.build(); the typecheck case shells out to tsc.
setDefaultTimeout(60_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

/** Write a one-file app importing `asset`, and compile it. */
async function compileWithAsset(
  assetName: string,
  bytes: Uint8Array,
): Promise<{ success: boolean; errors?: string[]; html?: string }> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-asset-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', assetName), bytes);
  await Bun.write(
    join(sandbox, 'src', 'main.ts'),
    `import asset from './${assetName}';\nexport const url = asset;\n`,
  );
  await Bun.write(join(sandbox, 'app.json'), '{"appId":"asset-probe","name":"Asset Probe"}');

  const result = await compileTypeScript(sandbox, { title: 'Asset Probe', minify: false });
  return {
    success: result.success,
    errors: result.errors,
    html: result.outputPath ? await Bun.file(result.outputPath).text() : undefined,
  };
}

describe('imported binary assets', () => {
  test('a .glb inlines as a model/gltf-binary data URI, not a sibling file', async () => {
    // "glTF" magic + a byte, so the base64 is recognizably this file's.
    const built = await compileWithAsset('level.glb', new Uint8Array([0x67, 0x6c, 0x54, 0x46, 7]));
    expect(built.errors ?? []).toEqual([]);
    expect(built.success).toBe(true);
    expect(built.html).toContain('data:model/gltf-binary;base64,');
  });

  test('an extension outside ASSET_MIME_TYPES fails the build instead of building green', async () => {
    const built = await compileWithAsset('scene.fbx', new Uint8Array([1, 2, 3, 4]));
    expect(built.success).toBe(false);
    const message = (built.errors ?? []).join('\n');
    expect(message).toContain('sibling asset');
    // The error has to name the fix, since the alternative is a runtime 403.
    expect(message).toContain('ASSET_MIME_TYPES');
  });

  test('an app that imports nothing binary produces no sibling assets', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-asset-'));
    await mkdir(join(sandbox, 'src'), { recursive: true });
    await Bun.write(join(sandbox, 'src', 'main.ts'), 'export const ready = true;\n');
    const result = await compileTypeScript(sandbox, { title: 'Plain', minify: false });
    expect(result.success).toBe(true);
  });

  test('an inlined asset typechecks — the two halves of the list agree', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'yaar-asset-'));
    await mkdir(join(sandbox, 'src'), { recursive: true });
    await Bun.write(join(sandbox, 'src', 'level.glb'), new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    await Bun.write(
      join(sandbox, 'src', 'main.ts'),
      `import level from './level.glb';\nexport const url: string = level;\n`,
    );
    const checked = await typecheckSandbox(sandbox, { bundles: [] });
    expect(checked.diagnostics).toEqual([]);
    expect(checked.success).toBe(true);
  });

  /**
   * The two lists are edited by hand in two files, and each half-edit fails
   * *later* and somewhere else: a `.d.ts` entry with no MIME type typechecks and
   * then dies in the build refusal above, a MIME type with no declaration builds
   * and then dies in `tsc`.
   */
  test('every inlined extension has an ambient module declaration, and vice versa', () => {
    const dts = readFileSync(BUNDLED_TYPES_DTS, 'utf-8');
    const declared = new Set(
      [...dts.matchAll(/^declare module '\*(\.[a-z0-9]+)' \{\n  const src: string;/gm)].map(
        (match) => match[1],
      ),
    );
    expect([...declared].sort()).toEqual(Object.keys(ASSET_MIME_TYPES).sort());
  });
});

describe('siblingAssetError', () => {
  test('says nothing about a build whose only output is the entry chunk', () => {
    expect(siblingAssetError({ outputs: [{ kind: 'entry-point' }] } as Bun.BuildOutput)).toBeNull();
  });

  test('names every sibling, since one import can emit several', () => {
    const message = siblingAssetError({
      outputs: [
        { kind: 'entry-point', path: './main.js' },
        { kind: 'asset', path: './a-1qzm5cr8.glb' },
        { kind: 'asset', path: './b-2xyz.fbx' },
      ],
    } as Bun.BuildOutput);
    expect(message).toContain('a-1qzm5cr8.glb');
    expect(message).toContain('b-2xyz.fbx');
    expect(message).toContain('2 sibling asset');
  });
});
