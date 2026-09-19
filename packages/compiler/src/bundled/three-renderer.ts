/**
 * Which three.js an app is built against: the classic WebGL build, or the
 * `three/webgpu` build that carries `WebGPURenderer`, node materials and TSL.
 *
 * **One app, one three.** `three` and `three/webgpu` are two entry points over
 * the same `three.core.js`, and the exe prebundles each into its own
 * self-contained artifact. An app that pulled in both would get two copies of
 * core — two `Mesh` classes, `instanceof` silently false across the seam. So the
 * choice is made once per app, in `app.json`:
 *
 *     { "three": "webgpu" }
 *
 * and the compiler then points `@bundled/three`, and every bare `three` an addon
 * imports, at the WebGPU build. App code keeps `import * as THREE from
 * '@bundled/three'` and finds `THREE.WebGPURenderer` there; `@bundled/three/tsl`
 * opens up for shader nodes. Without the field, `@bundled/three/webgpu` and
 * `@bundled/three/tsl` are refused rather than quietly bundling a second core.
 *
 * It is not an entry in `bundles`: that field means "privileged SDK", and the
 * server shows every entry of it in the install dialog as a capability to grant.
 * A renderer choice grants nothing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export type ThreeRenderer = 'webgl' | 'webgpu';

/** `@bundled/*` names that only exist in a `"three": "webgpu"` app. */
export const THREE_WEBGPU_LIBS = ['three/webgpu', 'three/tsl'] as const;

/** The npm entry `@bundled/three` and bare `three` resolve to under `renderer`. */
export function threeEntryFor(renderer: ThreeRenderer): 'three' | 'three/webgpu' {
  return renderer === 'webgpu' ? 'three/webgpu' : 'three';
}

/** The refusal for a WebGPU-only import in an app that did not opt in. */
export function threeWebGPUNotEnabledMessage(libName: string): string {
  return (
    `"@bundled/${libName}" requires "three": "webgpu" in app.json. ` +
    `An app is built against one three.js — WebGL or WebGPU — never both, because two ` +
    `builds are two copies of three's classes. With "three": "webgpu", ` +
    `@bundled/three itself resolves to the WebGPU build (THREE.WebGPURenderer).`
  );
}

/**
 * Read `three` from the app.json in `appRoot`. Anything but the exact string
 * `"webgpu"` — absent, malformed, a typo — is the default WebGL build, which is
 * what every app was compiled against before the field existed.
 */
export function readThreeRenderer(appRoot: string): ThreeRenderer {
  try {
    const json = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8'));
    return json?.three === 'webgpu' ? 'webgpu' : 'webgl';
  } catch {
    return 'webgl';
  }
}
