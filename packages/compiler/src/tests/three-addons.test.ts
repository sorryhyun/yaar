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
import { prebundleLibrary } from '../bundled/prebundle.js';
import { buildAppBundle } from '../build/build-app.js';
import type { ThreeRenderer } from '../bundled/three-renderer.js';

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

async function writeApp(source = APP_SOURCE, manifest: object = {}): Promise<string> {
  sandbox = await mkdtemp(join(tmpdir(), 'yaar-three-'));
  await mkdir(join(sandbox, 'src'), { recursive: true });
  await Bun.write(join(sandbox, 'src', 'main.ts'), source);
  await Bun.write(
    join(sandbox, 'app.json'),
    JSON.stringify({ appId: 'three-probe', name: 'Three Probe', ...manifest }),
  );
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

/**
 * `"three": "webgpu"` swaps which three the app links, not which three it
 * imports: `@bundled/three` and every addon's bare `three` land on the WebGPU
 * build. The one-core rule itself is proven against the exe's artifacts below —
 * in a repo install the two builds share one `three.core.js` file, so a count
 * here cannot see a misrouted addon.
 */
describe('"three": "webgpu"', () => {
  const WEBGPU_SOURCE = `
import * as THREE from '@bundled/three';
import { GLTFLoader, OrbitControls } from '@bundled/three/addons';
import { positionLocal, normalLocal, uniform } from '@bundled/three/tsl';

export const renderer = new THREE.WebGPURenderer({ antialias: true });
export const outline = new THREE.MeshBasicNodeMaterial();
outline.positionNode = positionLocal.add(normalLocal.mul(uniform(0.02)));
export const loader = new GLTFLoader();
export const controls = OrbitControls;
export const isObject = (o: unknown) => o instanceof THREE.Object3D;
`;

  test('@bundled/three, the addons and tsl all compile against the WebGPU build', async () => {
    const app = await writeApp(WEBGPU_SOURCE, { three: 'webgpu' });
    const result = await compileTypeScript(app, { title: 'Three Probe', minify: false });
    expect(result.errors ?? []).toEqual([]);
    expect(result.success).toBe(true);

    const html = await Bun.file(result.outputPath!).text();
    expect(html).toContain('class WebGPURenderer');
    expect(html).not.toContain('class WebGLRenderer');
    expect((html.match(/class Object3D\b/g) ?? []).length).toBe(1);
    expect((html.match(/class Vector3\b/g) ?? []).length).toBe(1);
  });

  test('typechecks, with @bundled/three declared as the WebGPU build', async () => {
    const app = await writeApp(WEBGPU_SOURCE, { three: 'webgpu' });
    const checked = await typecheckSandbox(app, { bundles: [] });
    expect(checked.diagnostics).toEqual([]);
    expect(checked.success).toBe(true);
  });

  test('WebGLRenderer is gone from @bundled/three in a WebGPU app', async () => {
    const app = await writeApp(
      `import * as THREE from '@bundled/three';\nexport const r = new THREE.WebGLRenderer();\n`,
      { three: 'webgpu' },
    );
    const checked = await typecheckSandbox(app, { bundles: [] });
    expect(checked.success).toBe(false);
    expect(checked.diagnostics.join('\n')).toContain('WebGLRenderer');
  });

  for (const lib of ['three/webgpu', 'three/tsl']) {
    test(`@bundled/${lib} without the flag is refused, not bundled beside WebGL three`, async () => {
      const app = await writeApp(
        `import * as THREE from '@bundled/three';\nimport * as X from '@bundled/${lib}';\n` +
          `export const probe = [THREE, X];\n`,
      );
      const result = await compileTypeScript(app, { title: 'Three Probe', minify: false });
      expect(result.success).toBe(false);
      expect((result.errors ?? []).join('\n')).toContain('"three": "webgpu"');

      const checked = await typecheckSandbox(app, { bundles: [] });
      expect(checked.success).toBe(false);
      expect(checked.diagnostics.join('\n')).toContain(`@bundled/${lib}`);
    });
  }
});

/**
 * The exe is where a second core would actually appear. In a repo install
 * `three.module.js` and `three.webgpu.js` both import the one `three.core.js`
 * file, so Bun dedupes them and every dev-mode case above would pass even with
 * the redirect broken. The exe instead links self-contained prebundled
 * artifacts, each root inlining its own core — so this builds against exactly
 * those artifacts and asks the running bundle whether an addon's classes are
 * the app's classes. (Minified artifacts rename classes, so counting
 * `class Object3D` in the output proves nothing here.)
 */
describe('one three in the exe', () => {
  const PROBE_SOURCE = `
import * as THREE from '@bundled/three';
import { BufferGeometryUtils } from '@bundled/three/addons';

const merged = BufferGeometryUtils.mergeGeometries([new THREE.BoxGeometry()]);
(globalThis as Record<string, unknown>).__threeProbe = {
  sameCore: merged instanceof THREE.BufferGeometry,
  webgpu: 'WebGPURenderer' in THREE,
};
`;

  async function runAgainstPrebundles(
    three: ThreeRenderer,
  ): Promise<{ sameCore: boolean; webgpu: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), 'yaar-three-exe-'));
    const globals = globalThis as Record<string, unknown>;
    try {
      const libs: Record<string, string> = {};
      for (const name of ['three', 'three/webgpu', 'three/tsl', 'three/addons']) {
        const file = join(dir, 'libs', `${name}.js`);
        await mkdir(join(file, '..'), { recursive: true });
        await Bun.write(file, await prebundleLibrary(name));
        libs[name] = file;
      }
      const entry = join(dir, 'main.ts');
      await Bun.write(entry, PROBE_SOURCE);

      globals.__YAAR_BUNDLED_LIBS = libs;
      const built = await buildAppBundle(entry, { minify: false, three });
      delete globals.__YAAR_BUNDLED_LIBS;
      expect(built.logs.filter((l) => l.level === 'error').map(String)).toEqual([]);
      expect(built.success).toBe(true);

      const out = join(dir, 'out.mjs');
      await Bun.write(out, await built.outputs[0].text());
      globals.self ??= globalThis;
      await import(out);
      return globals.__threeProbe as { sameCore: boolean; webgpu: boolean };
    } finally {
      delete globals.__YAAR_BUNDLED_LIBS;
      delete globals.__threeProbe;
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("WebGL app: addons build on the app's own classes", async () => {
    expect(await runAgainstPrebundles('webgl')).toEqual({ sameCore: true, webgpu: false });
  });

  test("WebGPU app: addons build on the WebGPU artifact's classes, not a WebGL copy", async () => {
    expect(await runAgainstPrebundles('webgpu')).toEqual({ sameCore: true, webgpu: true });
  });
});
