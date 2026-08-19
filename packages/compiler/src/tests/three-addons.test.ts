/**
 * `@bundled/three/addons` — three's `examples/jsm` half, and the one three.
 *
 * `@bundled/three` used to be three's core module and nothing else, so an app
 * that needed to open a `.glb` had no `GLTFLoader` to reach for and hand-rolled
 * a glTF 2.0 reader instead — accessors, PBR materials, embedded textures and
 * all — twice, in two unrelated apps.
 *
 * The addon modules all `import { ... } from 'three'`, which is the part with a
 * silent failure mode: a second copy of three in the bundle is a second
 * `Object3D`, and `gltf.scene instanceof THREE.Object3D` answers false with
 * nothing in the build to say why. The identity case below is the one that must
 * not regress.
 */
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { initCompiler } from '../config.js';
import { compileTypeScript } from '../compile.js';
import { typecheckSandbox } from '../typecheck.js';
import { BUNDLED_LIBRARIES, BUNDLED_SHIMS } from '../bundled/registry.js';

// Bundling three core plus the addon set is the cost of every case here.
setDefaultTimeout(120_000);

beforeAll(() => {
  initCompiler({ projectRoot: resolve(import.meta.dir, '../../../..'), isBundledExe: false });
});

let sandbox: string | null = null;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = null;
});

const APP_SOURCE = `
import * as THREE from '@bundled/three';
import { GLTFLoader, OrbitControls, BufferGeometryUtils } from '@bundled/three/addons';

export const scene = new THREE.Scene();
export const loader = new GLTFLoader();
export const controls = OrbitControls;
export const merge = BufferGeometryUtils.mergeVertices;
`;

async function writeApp(): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-three-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), APP_SOURCE);
  await Bun.write(join(sandbox, 'app.json'), '{"appId":"three-probe","name":"Three Probe"}');
  return sandbox;
}

describe('@bundled/three/addons', () => {
  test('is registered through its shim, so the addon set stays curated in one file', () => {
    expect(BUNDLED_LIBRARIES['three/addons']).toBeDefined();
    expect(BUNDLED_SHIMS['three/addons']).toContain('three-addons');
  });

  test('an app compiles against it, and the bundle carries exactly one three', async () => {
    const app = await writeApp();
    const result = await compileTypeScript(app, { title: 'Three Probe', minify: false });
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const html = await Bun.file(result.outputPath!).text();
    expect(html).toContain('GLTFLoader');
    // Two copies of three would be two class identities; every `instanceof`
    // across the seam would quietly answer false.
    expect((html.match(/class Object3D\b/g) ?? []).length).toBe(1);
    expect((html.match(/class Vector3\b/g) ?? []).length).toBe(1);
  });

  test('typechecks — the .d.ts block lists what the shim exports', async () => {
    const app = await writeApp();
    const checked = await typecheckSandbox(app, { bundles: [] });
    expect(checked.diagnostics).toEqual([]);
    expect(checked.success).toBe(true);
  });
});
