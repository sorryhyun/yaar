/**
 * glTF summaries against a GLB built by hand, so every expected number can be worked out on
 * paper: a box instanced under a scaled root, once translated and once rotated, one clip with
 * a rotation and a translation channel, a matrix-form camera node, and an embedded PNG.
 */
import { describe, it, expect } from 'bun:test';
import {
  GltfBuffers,
  GltfError,
  formatSummaryJson,
  parseGltfContainer,
  readAccessor,
  readImageHeader,
  summarizeGltf,
  type GltfJson,
} from '../gltf/index.js';

const S = Math.SQRT1_2;

/** Pack typed arrays into one buffer, 4-byte aligned, returning each one's bufferView. */
function packBuffers(parts: ArrayBufferView[]) {
  const views: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  let length = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: length, byteLength: p.byteLength });
    length += Math.ceil(p.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(length);
  parts.forEach((p, i) =>
    bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), views[i].byteOffset),
  );
  return { bin, views };
}

function glb(json: object, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(text.length / 4) * 4;
  const jsonChunk = new Uint8Array(jsonLen).fill(0x20);
  jsonChunk.set(text);
  const total = 12 + 8 + jsonLen + (bin ? 8 + bin.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  if (bin) {
    dv.setUint32(20 + jsonLen, bin.length, true);
    dv.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
  }
  return out;
}

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function fixture() {
  const { bin, views } = packBuffers([
    new Float32Array([-0.5, 0, -0.25, 0.5, 1, 0.25, 0, 0.5, 0]), // 0 positions
    new Uint16Array([0, 1, 2]), // 1 indices
    new Float32Array([0, 0.5, 1.2]), // 2 times
    new Float32Array([0, 0, 0, 1, S, 0, 0, S, 0, 0, 0, 1]), // 3 rotations: 0°, 90° about X, 0°
    new Float32Array([0, 0, 0, 0, 1, 0, 0, 0.5, 0]), // 4 translations
    pngHeader(64, 32), // 5 image
  ]);
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'hand' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Root', scale: [2, 2, 2], children: [1, 3] },
      { name: 'Arm', translation: [1, 0, 0], mesh: 0, children: [2] },
      { name: 'Hand', rotation: [0, S, 0, S], mesh: 0 },
      { name: 'Cam', camera: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 5, 1] },
      { name: 'Stray' },
    ],
    meshes: [
      { name: 'Box', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    ],
    materials: [
      {
        name: 'Steel',
        pbrMetallicRoughness: {
          metallicFactor: 0.8,
          roughnessFactor: 0.3,
          baseColorTexture: { index: 0 },
        },
      },
    ],
    textures: [{ source: 0 }],
    images: [{ name: 'steel.png', mimeType: 'image/png', bufferView: 5 }],
    cameras: [{ type: 'perspective', perspective: { yfov: Math.PI / 3, znear: 0.1 } }],
    animations: [
      {
        name: 'Reload',
        samplers: [
          { input: 2, output: 3 },
          { input: 2, output: 4 },
        ],
        channels: [
          { sampler: 0, target: { node: 1, path: 'rotation' } },
          { sampler: 1, target: { node: 2, path: 'translation' } },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.5, 0, -0.25],
        max: [0.5, 1, 0.25],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1.2] },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  return { json, bin };
}

type Rec = Record<string, any>;

describe('summarizeGltf', () => {
  it('places each instance in the world and unions the scene bounds', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin))) as Rec;
    expect(s.format).toBe('glb');
    const box = s.meshes[0];
    expect(box).toMatchObject({ name: 'Box', vertices: 3, triangles: 1, materials: ['Steel'] });
    expect(box.local).toEqual({ min: [-0.5, 0, -0.25], max: [0.5, 1, 0.25], size: [1, 1, 0.5] });
    // Arm: scale 2 after translate 1 → x (1±0.5)·2.
    expect(box.world[0]).toEqual({
      node: 'Arm',
      min: [1, 0, -0.5],
      max: [3, 2, 0.5],
      size: [2, 2, 1],
    });
    // Hand: rotated 90° about Y (x↔z), under Arm's translate, then the root's scale.
    expect(box.world[1]).toEqual({
      node: 'Hand',
      min: [1.5, 0, -1],
      max: [2.5, 2, 1],
      size: [1, 2, 2],
    });
    expect(s.bounds).toMatchObject({ min: [1, 0, -1], max: [3, 2, 1], center: [2, 1, 0] });
  });

  it('lists the tree with only non-default TRS, and splits matrix nodes back into TRS', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin))) as Rec;
    expect(s.nodes.map((n: Rec) => [n.name, n.parent, n.depth])).toEqual([
      ['Root', undefined, 0],
      ['Arm', 'Root', 1],
      ['Hand', 'Arm', 2],
      ['Cam', 'Root', 1],
    ]);
    expect(s.nodes[1]).toMatchObject({ t: [1, 0, 0], mesh: 'Box' });
    expect(s.nodes[1].r).toBeUndefined();
    expect(s.nodes[3]).toMatchObject({ t: [0, 1, 5], fromMatrix: true, camera: 0 });
    expect(s.notes).toContain('1 node(s) are not in the default scene and are not listed.');
    expect(s.cameras[0]).toMatchObject({ type: 'perspective', yfovDeg: 60 });
  });

  it('reports materials and texture sizes from the image header', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin))) as Rec;
    expect(s.materials[0]).toMatchObject({
      name: 'Steel',
      metallic: 0.8,
      roughness: 0.3,
      baseColorMap: 'steel.png',
    });
    expect(s.images[0]).toMatchObject({ mimeType: 'image/png', width: 64, height: 32 });
  });

  it('summarizes clips with per-channel stats while the file is small', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin))) as Rec;
    const clip = s.animations[0];
    expect(clip).toMatchObject({
      name: 'Reload',
      duration: 1.2,
      channels: 2,
      paths: { rotation: 1, translation: 1 },
    });
    expect(clip.channelStats[0]).toMatchObject({
      node: 'Arm',
      path: 'rotation',
      keys: 3,
      maxDegFromFirst: 90,
    });
    expect(clip.channelStats[1]).toMatchObject({
      node: 'Hand',
      path: 'translation',
      min: [0, 0, 0],
      max: [0, 1, 0],
    });
  });

  it('scopes nodes, meshes and channels to a subtree', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin), { node: 'hand' })) as Rec;
    expect(s.scope).toEqual({ node: 'Hand' });
    expect(s.nodes.map((n: Rec) => n.name)).toEqual(['Hand']);
    expect(s.meshes[0].world.map((w: Rec) => w.node)).toEqual(['Hand']);
    expect(s.animations[0].channelStats.map((c: Rec) => c.node)).toEqual(['Hand']);
    // The clip's length is the clip's, not the scoped channels'.
    expect(s.animations[0].duration).toBe(1.2);
    expect(s.images).toBeUndefined();
  });

  it('returns full keyframes as [time, ...value] rows', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin), { keys: 'reload', node: 'Arm' })) as Rec;
    expect(s.keyframes.animation).toBe('Reload');
    expect(s.keyframes.tracks).toHaveLength(2);
    expect(s.keyframes.tracks[1]).toEqual({
      node: 'Hand',
      path: 'translation',
      keys: [
        [0, 0, 0, 0],
        [0.5, 0, 1, 0],
        [1.2, 0, 0.5, 0],
      ],
    });
  });

  it('cuts keyframes at the value budget and says so', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin), { keys: 0, maxKeyValues: 12 })) as Rec;
    expect(s.keyframes.tracks[0]).toMatchObject({ path: 'rotation', keysNotShown: 1 });
    expect(s.keyframes.tracks[0].keys).toHaveLength(2);
    expect(s.keyframes.tracks[1].omitted).toBe('value budget spent');
  });

  it('says which nodes a clip keys when the scope holds none of them', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin), { keys: 'Reload', node: 'Cam' })) as Rec;
    expect(s.keyframes.tracks).toEqual([]);
    expect(s.notes).toContain('Reload keys nothing under Cam; it keys: Arm, Hand.');
  });

  it('limits the tree by depth and counts what it hid', async () => {
    const { json, bin } = fixture();
    const s = (await summarizeGltf(glb(json, bin), { depth: 1 })) as Rec;
    expect(s.nodes.map((n: Rec) => n.name)).toEqual(['Root', 'Arm', 'Cam']);
    expect(s.nodes[1].childrenNotShown).toBe(1);
    // Bounds still cover the whole scene — depth trims the listing, not the model.
    expect(s.bounds.max).toEqual([3, 2, 1]);
  });

  it('refuses a node name it cannot pin down, naming the candidates', async () => {
    const { json, bin } = fixture();
    await expect(summarizeGltf(glb(json, bin), { node: 'a' })).rejects.toThrow(/matches \d+ nodes/);
    await expect(summarizeGltf(glb(json, bin), { node: 'Elbow' })).rejects.toThrow(
      /No node matches "Elbow"/,
    );
    const byIndex = (await summarizeGltf(glb(json, bin), { node: '#2' })) as Rec;
    expect(byIndex.scope.node).toBe('Hand');
  });

  it('reads a .gltf whose buffer is a data: URI, and one whose buffer is a sidecar', async () => {
    const { json, bin } = fixture();
    const b64 = Buffer.from(bin).toString('base64');
    const embedded = {
      ...json,
      buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${b64}` }],
    };
    const s1 = (await summarizeGltf(new TextEncoder().encode(JSON.stringify(embedded)))) as Rec;
    expect(s1.format).toBe('gltf');
    expect(s1.animations[0].channelStats[0].maxDegFromFirst).toBe(90);

    const sidecar = { ...json, buffers: [{ byteLength: bin.length, uri: 'model.bin' }] };
    const text = new TextEncoder().encode(JSON.stringify(sidecar));
    const s2 = (await summarizeGltf(text, {
      resolveUri: async (uri) => (uri === 'model.bin' ? bin : null),
    })) as Rec;
    expect(s2.images[0].width).toBe(64);

    // No resolver: the JSON-only facts survive, the binary ones become notes and errors.
    const s3 = (await summarizeGltf(text)) as Rec;
    expect(s3.meshes[0].world[0].size).toEqual([2, 2, 1]);
    expect(s3.animations[0].channelStats[0].error).toMatch(/external file/);
  });

  it('rejects a truncated GLB and a glTF 1.0 asset', async () => {
    const { json, bin } = fixture();
    const bytes = glb(json, bin);
    expect(() => parseGltfContainer(bytes.subarray(0, bytes.length - 8))).toThrow(GltfError);
    const v1 = new TextEncoder().encode(JSON.stringify({ asset: { version: '1.0' } }));
    expect(() => parseGltfContainer(v1)).toThrow(/only 2.0/);
  });
});

describe('readAccessor', () => {
  it('normalizes integer components and applies sparse substitution', async () => {
    const { bin, views } = packBuffers([
      new Int16Array([32767, -32768, 0, 16384]), // dense values
      new Uint8Array([2]), // sparse index
      new Int16Array([-16384]), // sparse value
    ]);
    const json: GltfJson = {
      bufferViews: views,
      buffers: [{ byteLength: bin.length }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5122,
          normalized: true,
          count: 4,
          type: 'SCALAR',
          sparse: {
            count: 1,
            indices: { bufferView: 1, componentType: 5121 },
            values: { bufferView: 2 },
          },
        },
      ],
    };
    const data = await readAccessor(json, new GltfBuffers(json, bin), 0);
    expect(Array.from(data.values).map((v) => Number(v.toFixed(4)))).toEqual([1, -1, -0.5, 0.5]);
  });
});

describe('readImageHeader', () => {
  it('reads PNG and JPEG dimensions', () => {
    expect(readImageHeader(pngHeader(640, 480))).toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 480,
    });
    // SOI, an APP0 segment of length 4, then SOF0 (height 20, width 30).
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3,
    ]);
    expect(readImageHeader(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 30, height: 20 });
  });
});

describe('formatSummaryJson', () => {
  it('keeps a small record on one line and number arrays inline', () => {
    const text = formatSummaryJson({
      nodes: [{ name: 'Arm', t: [1, 0, 0] }],
      keys: [
        [0, 1],
        [0.5, 2],
      ],
      long: 'x'.repeat(200),
    });
    expect(text).toContain('{"name":"Arm","t":[1,0,0]}');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });
});
