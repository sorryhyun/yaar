/**
 * glTF 2.0 inspection: what a `.glb` or `.gltf` contains, as data rather than as a render.
 *
 * Reach for `summarizeGltf`, and `formatSummaryJson` to print it. The container, accessor and
 * matrix modules underneath are exported because they are separately testable.
 */

export {
  GltfError,
  isGlb,
  parseGltfContainer,
  type GltfContainer,
  type GltfJson,
} from './container.js';
export { GltfBuffers, readAccessor, type AccessorData, type UriResolver } from './accessor.js';
export { readImageHeader, type ImageHeader } from './image-size.js';
export { summarizeGltf, type GltfSummary, type GltfSummaryOptions } from './summarize.js';
export { formatSummaryJson } from './format.js';
