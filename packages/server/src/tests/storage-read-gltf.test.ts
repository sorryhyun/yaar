/**
 * `storageRead` on a 3D model answers with `@yaar/lib/gltf`'s summary instead of a binary
 * notice — so an agent can learn a model's sizes, tree and clips without a build, a preview,
 * or regexing a bundle for base64. The parser's own numbers are `@yaar/lib`'s tests; these
 * rows are the server's half: the options reach it, sidecars resolve against the model's
 * folder and nowhere else, and a broken file is a failed read rather than a thrown one.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { storageRead, storageWrite } from '../storage/storage-manager.js';

const DIR = 'read-gltf-fixture';

function modelJson(bufferUri: string) {
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Rifle', children: [1], scale: [2, 2, 2] },
      { name: 'Magazine', translation: [0, -1, 0], mesh: 0 },
    ],
    meshes: [{ name: 'Mag', primitives: [{ attributes: { POSITION: 0 } }] }],
    animations: [
      {
        name: 'Reload',
        samplers: [{ input: 1, output: 2 }],
        channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.1, 0, -0.05],
        max: [0.1, 0.3, 0.05],
      },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    buffers: [{ byteLength: 68, uri: bufferUri }],
  });
}

const BIN = Buffer.from(
  new Float32Array([
    ...[-0.1, 0, -0.05, 0.1, 0.3, 0.05, 0, 0.3, 0], // positions
    ...[0, 2], // times
    ...[0, 0, 0, 0, -0.2, 0], // translations
  ]).buffer,
);

describe('storageRead on a glTF model', () => {
  beforeAll(async () => {
    await storageWrite(`${DIR}/parts/mag.bin`, BIN);
    await storageWrite(`${DIR}/models/rifle.gltf`, modelJson('../parts/mag.bin'));
    await storageWrite(`${DIR}/models/escape.gltf`, modelJson('../../../../etc/hosts'));
    await storageWrite(`${DIR}/models/broken.glb`, Buffer.from('glTF\x02\0\0\0\xff\xff\0\0'));
  });

  it('returns the summary, with sizes from the tree, not a binary notice', async () => {
    const result = await storageRead(`${DIR}/models/rifle.gltf`);
    expect(result.success).toBe(true);
    const summary = JSON.parse(result.content!);
    expect(summary.format).toBe('gltf');
    expect(summary.meshes[0].world[0]).toMatchObject({ node: 'Magazine', size: [0.4, 0.6, 0.2] });
    expect(summary.readOptions.gltf.node).toBeDefined();
  });

  it('resolves a sidecar buffer against the model folder', async () => {
    const summary = JSON.parse((await storageRead(`${DIR}/models/rifle.gltf`)).content!);
    expect(summary.animations[0].channelStats[0]).toMatchObject({
      node: 'Magazine',
      path: 'translation',
      min: [0, -0.2, 0],
    });
  });

  it('passes node and keys through', async () => {
    const result = await storageRead(`${DIR}/models/rifle.gltf`, {
      gltf: { node: 'magazine', keys: 'Reload' },
    });
    const summary = JSON.parse(result.content!);
    expect(summary.scope.node).toBe('Magazine');
    expect(summary.keyframes.tracks[0].keys).toEqual([
      [0, 0, 0, 0],
      [2, 0, -0.2, 0],
    ]);
    // An explicit read already knows the options.
    expect(summary.readOptions).toBeUndefined();
  });

  it('passes the pose, window and display options through', async () => {
    // Reload slides the Magazine's translation from 0 to (0, -0.2, 0) over 2 s, under Rifle's
    // scale 2: its world y is twice the keyed value.
    const result = await storageRead(`${DIR}/models/rifle.gltf`, {
      gltf: { node: 'Magazine', pose: 'Reload', step: 1, omit: 'meshes,materials' },
    });
    const summary = JSON.parse(result.content!);
    expect(summary.pose.path.map((r: number[]) => r.slice(0, 4))).toEqual([
      [0, 0, 0, 0],
      [1, 0, -0.2, 0],
      [2, 0, -0.4, 0],
    ]);
    expect(summary.meshes).toBeUndefined();
    const windowed = JSON.parse(
      (
        await storageRead(`${DIR}/models/rifle.gltf`, {
          gltf: { keys: 'Reload', range: '0.5-1.5', step: 0.5 },
        })
      ).content!,
    );
    expect(windowed.keyframes.tracks[0].keys.map((r: number[]) => r[0])).toEqual([0.5, 1, 1.5]);
  });

  it('names every option in the hint a plain read carries', async () => {
    const summary = JSON.parse((await storageRead(`${DIR}/models/rifle.gltf`)).content!);
    expect(Object.keys(summary.readOptions.gltf).sort()).toEqual([
      'at',
      'depth',
      'euler',
      'keys',
      'node',
      'omit',
      'pose',
      'range',
      'step',
    ]);
  });

  it('never resolves a sidecar outside storage', async () => {
    const summary = JSON.parse((await storageRead(`${DIR}/models/escape.gltf`)).content!);
    expect(summary.animations[0].channelStats[0].error).toMatch(/not found/);
    // What the JSON alone knows still comes back.
    expect(summary.meshes[0].world[0].size).toEqual([0.4, 0.6, 0.2]);
  });

  it('fails the read, with the reason, on a file that is not a model', async () => {
    const result = await storageRead(`${DIR}/models/broken.glb`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('broken.glb');
    expect(result.error).toContain('truncated');
  });

  it('names an unknown node rather than returning an empty scope', async () => {
    const result = await storageRead(`${DIR}/models/rifle.gltf`, { gltf: { node: 'Stock' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No node matches "Stock"');
  });
});
