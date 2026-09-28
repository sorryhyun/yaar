/**
 * The glTF 2.0 container: a `.glb` (12-byte header, a JSON chunk, an optional BIN chunk) or a
 * `.gltf` (the JSON alone, its buffers named by URI).
 *
 * Only the framing is checked here. What the JSON says is `summarize.ts`'s business, and it
 * reads it defensively — a file a loader would reject can still be described up to the point
 * it goes wrong, which is the more useful answer for someone trying to find out *why*.
 */

/** A glTF file that could not be parsed at all, or an option that names nothing in it. */
export class GltfError extends Error {
  override name = 'GltfError';
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** The parts of the glTF JSON this module reads. Everything is optional: files lie. */
export interface GltfJson {
  asset?: {
    version?: string;
    generator?: string;
    copyright?: string;
    minVersion?: string;
    extras?: unknown;
  };
  scene?: number;
  scenes?: Array<{ name?: string; nodes?: number[]; extras?: unknown }>;
  nodes?: GltfNode[];
  meshes?: Array<{
    name?: string;
    primitives?: GltfPrimitive[];
    weights?: number[];
    extras?: unknown;
  }>;
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ uri?: string; byteLength?: number; name?: string }>;
  materials?: GltfMaterial[];
  textures?: Array<{
    source?: number;
    sampler?: number;
    name?: string;
    extensions?: Record<string, { source?: number }>;
  }>;
  images?: Array<{ uri?: string; mimeType?: string; bufferView?: number; name?: string }>;
  animations?: GltfAnimation[];
  skins?: Array<{
    name?: string;
    joints?: number[];
    skeleton?: number;
    inverseBindMatrices?: number;
  }>;
  cameras?: GltfCamera[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  camera?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  weights?: number[];
  extras?: unknown;
  extensions?: Record<string, unknown>;
}

export interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Array<Record<string, number>>;
  extensions?: Record<string, unknown>;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  normalized?: boolean;
  count?: number;
  type?: string;
  min?: number[];
  max?: number[];
  name?: string;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}

export interface GltfBufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
  name?: string;
  extensions?: Record<string, unknown>;
}

export interface GltfTextureInfo {
  index?: number;
  texCoord?: number;
  scale?: number;
  strength?: number;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
  };
  normalTexture?: GltfTextureInfo;
  occlusionTexture?: GltfTextureInfo;
  emissiveTexture?: GltfTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: Record<string, unknown>;
  extras?: unknown;
}

export interface GltfAnimation {
  name?: string;
  channels?: Array<{
    sampler?: number;
    target?: { node?: number; path?: string; extensions?: Record<string, { pointer?: string }> };
  }>;
  samplers?: Array<{ input?: number; output?: number; interpolation?: string }>;
  extras?: unknown;
}

export interface GltfCamera {
  name?: string;
  type?: string;
  perspective?: { yfov?: number; znear?: number; zfar?: number; aspectRatio?: number };
  orthographic?: { xmag?: number; ymag?: number; znear?: number; zfar?: number };
}

export interface GltfContainer {
  format: 'glb' | 'gltf';
  json: GltfJson;
  /** The GLB's BIN chunk — buffer 0 when that buffer has no `uri`. */
  bin: Uint8Array | null;
}

/** True when the bytes start with the GLB magic. */
export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && view(bytes).getUint32(0, true) === GLB_MAGIC;
}

/** Parse either container. A GLB is recognized by its magic, not by the file's name. */
export function parseGltfContainer(bytes: Uint8Array): GltfContainer {
  return isGlb(bytes) ? parseGlb(bytes) : { format: 'gltf', json: parseJson(bytes), bin: null };
}

function parseGlb(bytes: Uint8Array): GltfContainer {
  if (bytes.length < 12) throw new GltfError('GLB is shorter than its 12-byte header.');
  const dv = view(bytes);
  const version = dv.getUint32(4, true);
  if (version !== 2) {
    throw new GltfError(`GLB container version ${version} — only glTF 2.0 is supported.`);
  }
  const declared = dv.getUint32(8, true);
  if (declared > bytes.length) {
    throw new GltfError(
      `GLB is truncated: its header declares ${declared} bytes, the file has ${bytes.length}.`,
    );
  }

  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= declared) {
    const length = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > declared) {
      throw new GltfError(`GLB chunk at byte ${offset} runs past the end of the file.`);
    }
    const data = bytes.subarray(start, start + length);
    if (json === null) {
      if (type !== CHUNK_JSON) throw new GltfError('GLB does not begin with a JSON chunk.');
      json = parseJson(data);
    } else if (type === CHUNK_BIN && bin === null) {
      bin = data;
    }
    // Chunks of any other type are extension data; the spec says to skip them.
    offset = start + length;
  }
  if (json === null) throw new GltfError('GLB has no JSON chunk.');
  return { format: 'glb', json, bin };
}

function parseJson(bytes: Uint8Array): GltfJson {
  let text = new TextDecoder().decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GltfError(`glTF JSON does not parse: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GltfError('glTF JSON is not an object.');
  }
  const json = parsed as GltfJson;
  const major = json.asset?.version?.split('.')[0];
  if (major !== undefined && major !== '2') {
    throw new GltfError(`glTF asset version ${json.asset?.version} — only 2.0 is supported.`);
  }
  return json;
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
