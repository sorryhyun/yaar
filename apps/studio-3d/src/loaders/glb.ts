/**
 * glb.ts — glTF 2.0 (.gltf JSON and .glb binary container).
 * Hand-rolled: three/examples/jsm/GLTFLoader is not available.
 *
 * Supported: GLB chunk split, buffers / bufferViews / accessors (including
 * interleaved byteStride), POSITION / NORMAL / TEXCOORD_0 / COLOR_0 / indices,
 * node hierarchy via TRS or matrix, pbrMetallicRoughness → MeshStandardMaterial,
 * baseColor + emissive textures from embedded bufferViews or data: URIs.
 *
 * Explicitly refused with a user-facing message (Phase 4):
 *   • KHR_draco_mesh_compression, EXT_meshopt_compression
 *   • sparse accessors
 * Loaded, but warned about:
 *   • skins / animations (static bind pose only)
 */
import * as THREE from '@bundled/three';
import type { LoadOptions, LoadResult } from './types';

export class UnsupportedGltfError extends Error {}

/* --------------------------------------------------------------- types -- */

interface GltfJson {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[]; name?: string }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength?: number }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; sampler?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: unknown[];
  animations?: unknown[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
}

interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfTextureRef {
  index?: number;
  texCoord?: number;
}

interface GltfMaterial {
  name?: string;
  doubleSided?: boolean;
  alphaMode?: string;
  alphaCutoff?: number;
  emissiveFactor?: number[];
  normalTexture?: GltfTextureRef;
  emissiveTexture?: GltfTextureRef;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureRef;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureRef;
  };
}

type TypedArrayCtor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor;

const COMPONENT: Record<number, { ctor: TypedArrayCtor; bytes: number }> = {
  5120: { ctor: Int8Array, bytes: 1 },
  5121: { ctor: Uint8Array, bytes: 1 },
  5122: { ctor: Int16Array, bytes: 2 },
  5123: { ctor: Uint16Array, bytes: 2 },
  5125: { ctor: Uint32Array, bytes: 4 },
  5126: { ctor: Float32Array, bytes: 4 },
};

const NUM_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const WRAP: Record<number, THREE.Wrapping> = {
  33071: THREE.ClampToEdgeWrapping,
  33648: THREE.MirroredRepeatWrapping,
  10497: THREE.RepeatWrapping,
};

/* ------------------------------------------------------------- helpers -- */

function decodeDataUri(uri: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}

export function isGLB(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  return new DataView(buf).getUint32(0, true) === 0x46546c67; // 'glTF'
}

function splitGLB(buf: ArrayBuffer): { json: GltfJson; bin?: Uint8Array } {
  const view = new DataView(buf);
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new UnsupportedGltfError(
      `This is a glTF version ${version} file. 3D Studio only reads glTF 2.0.`,
    );
  }
  const total = Math.min(view.getUint32(8, true), buf.byteLength);
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | undefined;

  while (offset + 8 <= total) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = Math.min(start + chunkLength, buf.byteLength);
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, end - start)));
    } else if (chunkType === 0x004e4942) {
      bin = new Uint8Array(buf, start, end - start);
    }
    offset = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new UnsupportedGltfError('GLB file has no JSON chunk.');
  return { json, bin };
}

/* -------------------------------------------------------------- loader -- */

export async function loadGLTF(buf: ArrayBuffer, opts: LoadOptions): Promise<LoadResult> {
  const warnings: string[] = [];

  let json: GltfJson;
  let glbBin: Uint8Array | undefined;
  if (isGLB(buf)) {
    const split = splitGLB(buf);
    json = split.json;
    glbBin = split.bin;
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf))) as GltfJson;
    } catch {
      throw new UnsupportedGltfError('File is neither valid GLB nor valid glTF JSON.');
    }
  }

  const version = json.asset?.version ?? '';
  if (version && !version.startsWith('2')) {
    throw new UnsupportedGltfError(
      `This asset declares glTF ${version}. 3D Studio only reads glTF 2.0.`,
    );
  }

  // ---- hard refusals, with names the user can act on ------------------
  const required = json.extensionsRequired ?? [];
  const blocked: Record<string, string> = {
    KHR_draco_mesh_compression: 'Draco mesh compression',
    EXT_meshopt_compression: 'meshopt compression',
    KHR_texture_basisu: 'KTX2/Basis compressed textures',
  };
  for (const ext of required) {
    if (blocked[ext]) {
      throw new UnsupportedGltfError(
        `This model uses ${blocked[ext]} (${ext}), which 3D Studio cannot decompress yet. ` +
          'Re-export it without compression, or wait for Phase 4.',
      );
    }
  }
  const usesDraco = (json.meshes ?? []).some((m) =>
    (m.primitives ?? []).some((p) => p.extensions && 'KHR_draco_mesh_compression' in p.extensions),
  );
  if (usesDraco) {
    throw new UnsupportedGltfError(
      'This model has Draco-compressed meshes (KHR_draco_mesh_compression), which 3D Studio ' +
        'cannot decompress yet. Re-export without Draco.',
    );
  }
  if ((json.accessors ?? []).some((a) => a.sparse)) {
    throw new UnsupportedGltfError(
      'This model uses sparse accessors, which 3D Studio does not support yet.',
    );
  }

  if (json.skins?.length) {
    warnings.push(
      `Skinned meshes (${json.skins.length}) are loaded in their static bind pose — skinning arrives in Phase 4.`,
    );
  }
  if (json.animations?.length) {
    warnings.push(
      `${json.animations.length} animation clip(s) were ignored — animation arrives in Phase 4.`,
    );
  }
  for (const ext of json.extensionsUsed ?? []) {
    if (!required.includes(ext) && !ext.startsWith('KHR_materials')) continue;
  }

  // ---- buffers --------------------------------------------------------
  const buffers: (Uint8Array | null)[] = [];
  const declared = json.buffers ?? [];
  for (let i = 0; i < declared.length; i += 1) {
    const b = declared[i];
    if (!b.uri) {
      buffers.push(glbBin ?? null);
      if (!glbBin) warnings.push('A GLB binary chunk was expected but missing.');
      continue;
    }
    const data = decodeDataUri(b.uri);
    if (data) {
      buffers.push(data.bytes);
      continue;
    }
    if (opts.resolve) {
      const fetched = await opts.resolve(b.uri).catch(() => null);
      if (fetched) {
        buffers.push(new Uint8Array(fetched));
        continue;
      }
    }
    buffers.push(null);
    warnings.push(`External buffer "${b.uri}" could not be loaded — part of the model is missing.`);
  }

  const bufferViews = json.bufferViews ?? [];
  const accessors = json.accessors ?? [];

  function viewBytes(index: number): Uint8Array | null {
    const bv = bufferViews[index];
    if (!bv) return null;
    const src = buffers[bv.buffer];
    if (!src) return null;
    const start = bv.byteOffset ?? 0;
    return src.subarray(start, start + bv.byteLength);
  }

  function readAccessor(index: number): THREE.BufferAttribute | null {
    const acc = accessors[index];
    if (!acc) return null;
    const comp = COMPONENT[acc.componentType];
    const itemSize = NUM_COMPONENTS[acc.type];
    if (!comp || !itemSize) return null;

    if (acc.bufferView === undefined) {
      // spec: absent bufferView means all zeros
      return new THREE.BufferAttribute(new comp.ctor(acc.count * itemSize), itemSize, acc.normalized);
    }
    const bv = bufferViews[acc.bufferView];
    const src = bv ? buffers[bv.buffer] : null;
    if (!bv || !src) return null;

    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const elementBytes = comp.bytes * itemSize;
    const stride = bv.byteStride && bv.byteStride !== elementBytes ? bv.byteStride : 0;

    if (!stride) {
      // tightly packed — but the offset may not be aligned to the component
      const byteLen = acc.count * elementBytes;
      if (base + byteLen > src.byteLength) return null;
      const slice = src.buffer.slice(src.byteOffset + base, src.byteOffset + base + byteLen);
      const array = new (comp.ctor as Float32ArrayConstructor)(slice as ArrayBuffer);
      return new THREE.BufferAttribute(array, itemSize, acc.normalized);
    }

    // interleaved — de-interleave into a packed array
    const out = new comp.ctor(acc.count * itemSize);
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    for (let i = 0; i < acc.count; i += 1) {
      const o = base + i * stride;
      for (let c = 0; c < itemSize; c += 1) {
        const p = o + c * comp.bytes;
        if (p + comp.bytes > view.byteLength) break;
        let v = 0;
        switch (acc.componentType) {
          case 5120:
            v = view.getInt8(p);
            break;
          case 5121:
            v = view.getUint8(p);
            break;
          case 5122:
            v = view.getInt16(p, true);
            break;
          case 5123:
            v = view.getUint16(p, true);
            break;
          case 5125:
            v = view.getUint32(p, true);
            break;
          default:
            v = view.getFloat32(p, true);
        }
        out[i * itemSize + c] = v;
      }
    }
    return new THREE.BufferAttribute(out, itemSize, acc.normalized);
  }

  // ---- textures -------------------------------------------------------
  const textureCache = new Map<number, THREE.Texture | null>();

  async function loadTexture(ref: GltfTextureRef | undefined, srgb: boolean): Promise<THREE.Texture | null> {
    if (!ref || ref.index === undefined) return null;
    if (textureCache.has(ref.index)) return textureCache.get(ref.index) ?? null;
    textureCache.set(ref.index, null);

    const texDef = json.textures?.[ref.index];
    const image = texDef?.source !== undefined ? json.images?.[texDef.source] : undefined;
    if (!image) return null;

    let bytes: Uint8Array | null = null;
    let mime = image.mimeType ?? 'image/png';
    if (image.bufferView !== undefined) {
      bytes = viewBytes(image.bufferView);
    } else if (image.uri) {
      const data = decodeDataUri(image.uri);
      if (data) {
        bytes = data.bytes;
        mime = image.mimeType ?? data.mime;
      } else if (opts.resolve) {
        const fetched = await opts.resolve(image.uri).catch(() => null);
        if (fetched) bytes = new Uint8Array(fetched);
      }
    }
    if (!bytes) {
      warnings.push(`Texture "${image.name ?? image.uri ?? ref.index}" could not be decoded.`);
      return null;
    }

    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const bitmap = await createImageBitmap(new Blob([copy], { type: mime }));
      const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      tex.flipY = false;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const sampler = texDef?.sampler !== undefined ? json.samplers?.[texDef.sampler] : undefined;
      tex.wrapS = WRAP[sampler?.wrapS ?? 10497] ?? THREE.RepeatWrapping;
      tex.wrapT = WRAP[sampler?.wrapT ?? 10497] ?? THREE.RepeatWrapping;
      tex.needsUpdate = true;
      textureCache.set(ref.index, tex);
      return tex;
    } catch {
      warnings.push('An embedded texture could not be decoded by the browser.');
      return null;
    }
  }

  // ---- materials ------------------------------------------------------
  const materialCache = new Map<number, THREE.MeshStandardMaterial>();

  async function buildMaterial(index: number | undefined): Promise<THREE.MeshStandardMaterial> {
    if (index === undefined) {
      return new THREE.MeshStandardMaterial({ color: 0xb9c4d0, roughness: 0.7, metalness: 0.05 });
    }
    const cached = materialCache.get(index);
    if (cached) return cached;

    const def = json.materials?.[index] ?? {};
    const pbr = def.pbrMetallicRoughness ?? {};
    const base = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base[0] ?? 1, base[1] ?? 1, base[2] ?? 1),
      metalness: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      opacity: base[3] ?? 1,
      transparent: def.alphaMode === 'BLEND' || (base[3] ?? 1) < 1,
      side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    mat.name = def.name ?? `material_${index}`;
    if (def.alphaMode === 'MASK') {
      mat.alphaTest = def.alphaCutoff ?? 0.5;
      mat.transparent = false;
    }
    const emissive = def.emissiveFactor;
    if (emissive) mat.emissive = new THREE.Color(emissive[0] ?? 0, emissive[1] ?? 0, emissive[2] ?? 0);

    const map = await loadTexture(pbr.baseColorTexture, true);
    if (map) mat.map = map;
    const emissiveMap = await loadTexture(def.emissiveTexture, true);
    if (emissiveMap) mat.emissiveMap = emissiveMap;
    const mrMap = await loadTexture(pbr.metallicRoughnessTexture, false);
    if (mrMap) {
      mat.metalnessMap = mrMap;
      mat.roughnessMap = mrMap;
    }
    const normalMap = await loadTexture(def.normalTexture, false);
    if (normalMap) mat.normalMap = normalMap;

    materialCache.set(index, mat);
    return mat;
  }

  // ---- primitives -----------------------------------------------------
  let skippedModes = 0;

  async function buildPrimitive(prim: GltfPrimitive, label: string): Promise<THREE.Mesh | null> {
    const mode = prim.mode ?? 4;
    if (mode !== 4) {
      skippedModes += 1;
      return null;
    }
    const geo = new THREE.BufferGeometry();
    const position = prim.attributes.POSITION !== undefined ? readAccessor(prim.attributes.POSITION) : null;
    if (!position) return null;
    geo.setAttribute('position', position);

    if (prim.attributes.NORMAL !== undefined) {
      const n = readAccessor(prim.attributes.NORMAL);
      if (n) geo.setAttribute('normal', n);
    }
    if (prim.attributes.TEXCOORD_0 !== undefined) {
      const uv = readAccessor(prim.attributes.TEXCOORD_0);
      if (uv) geo.setAttribute('uv', uv);
    }
    let vertexColors = false;
    if (prim.attributes.COLOR_0 !== undefined) {
      const c = readAccessor(prim.attributes.COLOR_0);
      if (c) {
        geo.setAttribute('color', c);
        vertexColors = true;
      }
    }
    if (prim.indices !== undefined) {
      const idx = readAccessor(prim.indices);
      if (idx) geo.setIndex(new THREE.BufferAttribute(idx.array, 1));
    }
    if (!geo.getAttribute('normal')) {
      geo.computeVertexNormals();
    }
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mat = await buildMaterial(prim.material);
    if (vertexColors && !mat.vertexColors) {
      mat.vertexColors = true;
      mat.needsUpdate = true;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = label;
    return mesh;
  }

  const meshCache = new Map<number, THREE.Object3D>();

  async function buildMesh(index: number): Promise<THREE.Object3D | null> {
    const def = json.meshes?.[index];
    if (!def) return null;
    const name = def.name ?? `mesh_${index}`;
    const prims: THREE.Mesh[] = [];
    for (let i = 0; i < def.primitives.length; i += 1) {
      const mesh = await buildPrimitive(
        def.primitives[i],
        def.primitives.length > 1 ? `${name}_${i}` : name,
      );
      if (mesh) prims.push(mesh);
    }
    if (prims.length === 0) return null;
    if (prims.length === 1) return prims[0];
    const group = new THREE.Group();
    group.name = name;
    for (const p of prims) group.add(p);
    meshCache.set(index, group);
    return group;
  }

  // ---- nodes ----------------------------------------------------------
  const nodes = json.nodes ?? [];
  const visiting = new Set<number>();

  async function buildNode(index: number): Promise<THREE.Object3D | null> {
    if (visiting.has(index)) return null; // cyclic graph guard
    visiting.add(index);
    const def = nodes[index];
    if (!def) return null;

    let obj: THREE.Object3D | null = null;
    if (def.mesh !== undefined) obj = await buildMesh(def.mesh);
    const hasChildren = (def.children?.length ?? 0) > 0;
    if (obj && hasChildren) {
      const wrapper = new THREE.Group();
      wrapper.name = def.name ?? `node_${index}`;
      wrapper.add(obj);
      obj = wrapper;
    }
    if (!obj) {
      obj = new THREE.Group();
    }
    obj.name = def.name ?? obj.name ?? `node_${index}`;

    if (def.matrix && def.matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(def.matrix);
      m.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      if (def.translation) obj.position.fromArray(def.translation);
      if (def.rotation) obj.quaternion.fromArray(def.rotation);
      if (def.scale) obj.scale.fromArray(def.scale);
    }

    for (const childIndex of def.children ?? []) {
      const child = await buildNode(childIndex);
      if (child) obj.add(child);
    }
    visiting.delete(index);
    return obj;
  }

  const sceneIndex = json.scene ?? 0;
  const sceneDef = json.scenes?.[sceneIndex] ?? json.scenes?.[0];
  const rootIndices = sceneDef?.nodes ?? nodes.map((_, i) => i);

  const root = new THREE.Group();
  root.name = sceneDef?.name || opts.name.replace(/\.[^.]+$/, '') || 'glTF';
  for (const i of rootIndices) {
    const child = await buildNode(i);
    if (child) root.add(child);
  }

  if (skippedModes > 0) {
    warnings.push(
      `${skippedModes} primitive(s) used a non-triangle draw mode (points/lines) and were skipped.`,
    );
  }

  let meshCount = 0;
  root.traverse((o) => {
    if ((o as unknown as { isMesh?: boolean }).isMesh) meshCount += 1;
  });
  if (meshCount === 0) throw new UnsupportedGltfError('No renderable triangle meshes found in this glTF.');

  // glTF is Y-up right-handed, same as three.js — no axis conversion needed.
  if (root.children.length === 1 && root.children[0].name) {
    const only = root.children[0];
    if (
      only.position.lengthSq() === 0 &&
      only.scale.x === 1 &&
      only.scale.y === 1 &&
      only.scale.z === 1
    ) {
      only.name = only.name || root.name;
      return { object: only, warnings };
    }
  }
  return { object: root, warnings };
}
