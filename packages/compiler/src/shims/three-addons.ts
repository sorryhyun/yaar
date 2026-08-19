/**
 * `@bundled/three/addons` — the `examples/jsm` half of three.js.
 *
 * `@bundled/three` is three's core module and nothing else, so an app that
 * needed to open a `.glb` had no loader to reach for and hand-rolled a glTF
 * reader instead — twice, in two different apps. This shim is the curated addon
 * surface those apps should have imported.
 *
 * **Curated, not `export * from 'three/addons'`.** three's own `Addons.js`
 * barrel is every addon it ships (hundreds of modules), and the exe embeds this
 * artifact whole — there is no tree-shaking on the way into the binary. Each
 * name below is here because an app cannot reasonably hand-roll it; adding one
 * is a line here plus a line in the `.d.ts` block.
 *
 * **Why the compressed-mesh loaders are absent.** `DRACOLoader`, `KTX2Loader`
 * and `MeshoptDecoder` do not decode anything themselves — they fetch a decoder
 * (`.wasm` plus a worker `.js`) from a path the app sets at runtime. A YAAR app
 * is a single self-contained HTML file with no siblings to serve, so that fetch
 * has nowhere to point: they would compile and then fail on first use, which is
 * worse than not offering them. Uncompressed glTF/GLB needs none of them.
 *
 * Imports of `three` inside these modules stay bare on purpose: the prebundle
 * marks `three` external and the compiler plugin redirects it to the one shared
 * `@bundled/three` artifact. Two copies of three would be two class identities,
 * and every `instanceof` across the seam would quietly answer false.
 */

// Loaders
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
export { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
export { STLLoader } from 'three/addons/loaders/STLLoader.js';
export { FontLoader } from 'three/addons/loaders/FontLoader.js';
export { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

// Exporters — the return trip for an app that edits a scene.
export { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Controls
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { MapControls } from 'three/addons/controls/MapControls.js';
export { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
export { TransformControls } from 'three/addons/controls/TransformControls.js';

// Geometries
export { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

// Utils
export * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
export * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
