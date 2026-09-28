/**
 * Accessor decoding: bytes in a buffer view → numbers.
 *
 * The one part of a glTF summary that needs the binary payload. Bounds, counts and clip
 * durations are all in the JSON (`min`/`max` are required on POSITION and on animation
 * inputs); keyframe values, inverse bind matrices and embedded image headers are not.
 */

import { GltfError, view, type GltfJson } from './container.js';

const COMPONENTS: Record<
  number,
  { size: number; read: (dv: DataView, at: number) => number; norm?: number }
> = {
  5120: { size: 1, read: (dv, at) => dv.getInt8(at), norm: 127 },
  5121: { size: 1, read: (dv, at) => dv.getUint8(at), norm: 255 },
  5122: { size: 2, read: (dv, at) => dv.getInt16(at, true), norm: 32767 },
  5123: { size: 2, read: (dv, at) => dv.getUint16(at, true), norm: 65535 },
  5125: { size: 4, read: (dv, at) => dv.getUint32(at, true), norm: 4294967295 },
  5126: { size: 4, read: (dv, at) => dv.getFloat32(at, true) },
};

const TYPE_SIZES: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** Resolves a buffer or image `uri` that is not a `data:` URI — a sidecar file. */
export type UriResolver = (uri: string) => Promise<Uint8Array | null>;

export interface AccessorData {
  count: number;
  itemSize: number;
  /** `count * itemSize` values, normalized when the accessor says so. */
  values: Float64Array;
}

export function componentCount(type: string | undefined): number {
  return (type && TYPE_SIZES[type]) || 0;
}

/**
 * Apply an accessor's `normalized` flag to one stored value. Exported for `min`/`max`,
 * which the spec stores un-normalized: "the normalized flag has no effect on these".
 */
export function normalizeComponent(value: number, componentType: number | undefined): number {
  const c = componentType !== undefined ? COMPONENTS[componentType] : undefined;
  if (!c?.norm) return value;
  return componentType === 5120 || componentType === 5122
    ? Math.max(value / c.norm, -1)
    : value / c.norm;
}

/** Lazily loads and caches a file's buffers; answers buffer views as byte slices. */
export class GltfBuffers {
  private readonly cache = new Map<number, Promise<Uint8Array>>();

  constructor(
    private readonly json: GltfJson,
    private readonly bin: Uint8Array | null,
    private readonly resolveUri?: UriResolver,
  ) {}

  /** A buffer view's bytes. Throws a `GltfError` naming why when they cannot be had. */
  async bufferView(index: number): Promise<Uint8Array> {
    const bv = this.json.bufferViews?.[index];
    if (!bv) throw new GltfError(`bufferView ${index} does not exist.`);
    const compressed = Object.keys(bv.extensions ?? {}).find((k) =>
      k.endsWith('meshopt_compression'),
    );
    if (compressed) {
      throw new GltfError(
        `bufferView ${index} is ${compressed}-compressed; it is not decoded here.`,
      );
    }
    const buffer = await this.buffer(bv.buffer ?? 0);
    const start = bv.byteOffset ?? 0;
    const end = start + (bv.byteLength ?? 0);
    if (end > buffer.length) {
      throw new GltfError(`bufferView ${index} runs past the end of buffer ${bv.buffer ?? 0}.`);
    }
    return buffer.subarray(start, end);
  }

  buffer(index: number): Promise<Uint8Array> {
    let cached = this.cache.get(index);
    if (!cached) {
      cached = this.loadBuffer(index);
      this.cache.set(index, cached);
    }
    return cached;
  }

  /** Bytes behind a `uri` — a `data:` URI decoded in place, anything else via the resolver. */
  async uri(uri: string): Promise<Uint8Array> {
    const data = decodeDataUri(uri);
    if (data) return data;
    if (!this.resolveUri)
      throw new GltfError(`"${uri}" is an external file and cannot be resolved here.`);
    const bytes = await this.resolveUri(uri);
    if (!bytes) throw new GltfError(`External file "${uri}" was not found.`);
    return bytes;
  }

  private async loadBuffer(index: number): Promise<Uint8Array> {
    const buffer = this.json.buffers?.[index];
    if (!buffer) throw new GltfError(`buffer ${index} does not exist.`);
    if (buffer.uri === undefined) {
      if (index === 0 && this.bin) return this.bin;
      throw new GltfError(`buffer ${index} has no uri and there is no GLB BIN chunk.`);
    }
    return this.uri(buffer.uri);
  }
}

function decodeDataUri(uri: string): Uint8Array | null {
  const m = /^data:[^,]*?(;base64)?,/.exec(uri);
  if (!m) return null;
  const payload = uri.slice(m[0].length);
  return m[1]
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new TextEncoder().encode(decodeURIComponent(payload));
}

/** Decode an accessor, sparse substitution and normalization included. */
export async function readAccessor(
  json: GltfJson,
  buffers: GltfBuffers,
  index: number,
): Promise<AccessorData> {
  const acc = json.accessors?.[index];
  if (!acc) throw new GltfError(`accessor ${index} does not exist.`);
  const itemSize = componentCount(acc.type);
  const comp = acc.componentType !== undefined ? COMPONENTS[acc.componentType] : undefined;
  if (!itemSize || !comp) {
    throw new GltfError(`accessor ${index} has an unknown type/componentType.`);
  }
  const count = acc.count ?? 0;
  const values = new Float64Array(count * itemSize);

  if (acc.bufferView !== undefined) {
    const bytes = await buffers.bufferView(acc.bufferView);
    const dv = view(bytes);
    // Matrix columns are 4-byte aligned, which pads MAT2/MAT3 of 1- and 2-byte components.
    const columns = acc.type === 'MAT2' ? 2 : acc.type === 'MAT3' ? 3 : acc.type === 'MAT4' ? 4 : 1;
    const rows = itemSize / columns;
    const columnBytes = rows * comp.size;
    const columnStride = columns > 1 ? Math.ceil(columnBytes / 4) * 4 : columnBytes;
    const elementBytes = columnStride * columns;
    const stride = json.bufferViews?.[acc.bufferView]?.byteStride || elementBytes;
    const base = acc.byteOffset ?? 0;
    if (count > 0 && base + stride * (count - 1) + elementBytes > bytes.length) {
      throw new GltfError(`accessor ${index} runs past the end of its bufferView.`);
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < columns; c++) {
        for (let r = 0; r < rows; r++) {
          const at = base + i * stride + c * columnStride + r * comp.size;
          values[i * itemSize + c * rows + r] = comp.read(dv, at);
        }
      }
    }
  }

  if (acc.sparse && acc.sparse.count > 0) {
    const { indices, values: sparseValues } = acc.sparse;
    const indexComp = COMPONENTS[indices.componentType];
    if (!indexComp) throw new GltfError(`accessor ${index} has sparse indices of an unknown type.`);
    const idxView = view(await buffers.bufferView(indices.bufferView));
    const valView = view(await buffers.bufferView(sparseValues.bufferView));
    const idxBase = indices.byteOffset ?? 0;
    const valBase = sparseValues.byteOffset ?? 0;
    for (let s = 0; s < acc.sparse.count; s++) {
      const target = indexComp.read(idxView, idxBase + s * indexComp.size);
      if (target >= count)
        throw new GltfError(`accessor ${index} has a sparse index out of range.`);
      for (let k = 0; k < itemSize; k++) {
        values[target * itemSize + k] = comp.read(
          valView,
          valBase + (s * itemSize + k) * comp.size,
        );
      }
    }
  }

  if (acc.normalized && comp.norm) {
    for (let i = 0; i < values.length; i++)
      values[i] = normalizeComponent(values[i], acc.componentType);
  }
  return { count, itemSize, values };
}
