/**
 * A glTF file described as data a reader can act on: the node tree with local TRS, every mesh
 * with its local and world bounds, materials, image sizes, and what each animation clip keys.
 *
 * Structure and bounds come from the JSON alone (POSITION and animation-input `min`/`max` are
 * required by the spec). The binary payload is touched only for what lives nowhere else:
 * per-channel keyframe statistics, full keyframes on request, a skin's bind matrix, and the
 * first bytes of each image.
 *
 * Nothing here renders, loads textures, or evaluates an animation. Bounds are the rest pose,
 * morph targets are ignored, and a skinned mesh is placed by its first joint's bind matrix —
 * the answer a loader would give before its first frame.
 */

import { GltfError, parseGltfContainer, type GltfTextureInfo } from './container.js';
import { GltfBuffers, normalizeComponent, readAccessor, type UriResolver } from './accessor.js';
import {
  compose,
  decompose,
  fromArray,
  identity,
  multiply,
  quatAngleDeg,
  transformBox,
  type Mat4,
  type Quat,
  type Vec3,
} from './matrix.js';
import { readImageHeader } from './image-size.js';

export interface GltfSummaryOptions {
  /**
   * Scope the summary to this node's subtree — a name (exact, then case-insensitive, then a
   * unique substring) or an index (`12` or `"#12"`). Scoped, meshes, materials and animation
   * channels are only those the subtree uses, and every channel gets keyframe statistics.
   */
  node?: string | number;
  /** How many levels below the root(s) the node list goes. Unlimited by default. */
  depth?: number;
  /**
   * An animation (name or index) whose keyframes to return in full, as `[time, ...value]`
   * rows — only the channels inside `node`'s subtree when that is set too.
   */
  keys?: string | number;
  /** Bytes for a buffer or image URI that is not a `data:` URI. Without it they are skipped. */
  resolveUri?: UriResolver;
  /** Node-list cap. Default 400. */
  maxNodes?: number;
  /** Total numbers `keys` may return before tracks are cut. Default 20,000. */
  maxKeyValues?: number;
}

export type GltfSummary = Record<string, unknown>;

const DEFAULT_MAX_NODES = 400;
const DEFAULT_MAX_KEY_VALUES = 20_000;
/** Per-channel stats appear unscoped only while the whole file has at most this many channels. */
const CHANNEL_STATS_LIMIT = 64;
const LIST_CAP = 200;
const INSTANCE_CAP = 16;
/** Past this many meshes an unscoped read lists each on one line: its world size, not its boxes. */
const COMPACT_MESHES_OVER = 40;
const MODE_NAMES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP'];

export async function summarizeGltf(
  bytes: Uint8Array,
  opts: GltfSummaryOptions = {},
): Promise<GltfSummary> {
  const { format, json, bin } = parseGltfContainer(bytes);
  const buffers = new GltfBuffers(json, bin, opts.resolveUri);
  const notes: string[] = [];
  const nodes = json.nodes ?? [];
  const accessors = json.accessors ?? [];
  const clips = json.animations ?? [];

  const nodeLabel = labeler(nodes.map((n) => n.name));
  const meshLabel = labeler((json.meshes ?? []).map((m) => m.name));
  const materialLabel = labeler((json.materials ?? []).map((m) => m.name));
  const clipLabel = labeler(clips.map((a) => a.name));
  const imageLabel = labeler(
    (json.images ?? []).map(
      (im) => im.name ?? (im.uri && !im.uri.startsWith('data:') ? im.uri : undefined),
    ),
  );
  const textureLabel = (ti: number): string => {
    const tex = json.textures?.[ti];
    const source =
      tex?.source ??
      Object.values(tex?.extensions ?? {}).find((e) => e?.source !== undefined)?.source;
    return source !== undefined ? imageLabel(source) : `texture#${ti}`;
  };

  // ── Tree ────────────────────────────────────────────────────────────
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((n, i) =>
    n.children?.forEach((c) => {
      if (c >= 0 && c < nodes.length && c !== i && parent[c] === -1) parent[c] = i;
    }),
  );
  const local = nodes.map((n) =>
    n.matrix?.length === 16
      ? fromArray(n.matrix)
      : compose(vec3(n.translation, 0), quat(n.rotation), vec3(n.scale, 1)),
  );
  const world: Array<Mat4 | undefined> = [];
  const worldOf = (i: number, guard = 0): Mat4 => {
    const cached = world[i];
    if (cached) return cached;
    const p = parent[i];
    const m = p < 0 || guard > nodes.length ? local[i] : multiply(worldOf(p, guard + 1), local[i]);
    world[i] = m;
    return m;
  };

  const sceneIndex = json.scene ?? (json.scenes?.length ? 0 : undefined);
  const sceneRoots =
    sceneIndex !== undefined
      ? (json.scenes?.[sceneIndex]?.nodes ?? [])
      : nodes.map((_, i) => i).filter((i) => parent[i] < 0);
  const scopeRoot =
    opts.node !== undefined
      ? resolveByName(
          nodes.map((n) => n.name),
          opts.node,
          'node',
        )
      : undefined;
  const scoped = scopeRoot !== undefined;

  const inScope = new Set<number>();
  const order: Array<{ i: number; depth: number }> = [];
  const stack = (scoped ? [scopeRoot] : sceneRoots)
    .slice()
    .reverse()
    .map((i) => ({ i, depth: 0 }));
  while (stack.length) {
    const { i, depth } = stack.pop()!;
    if (inScope.has(i) || !nodes[i]) continue;
    inScope.add(i);
    order.push({ i, depth });
    const children = nodes[i].children ?? [];
    for (let k = children.length - 1; k >= 0; k--) stack.push({ i: children[k], depth: depth + 1 });
  }
  if (!scoped && inScope.size < nodes.length) {
    notes.push(
      `${nodes.length - inScope.size} node(s) are not in the default scene and are not listed.`,
    );
  }

  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const nodeEntries: GltfSummary[] = [];
  let beyondDepth = 0;
  let beyondCap = 0;
  for (const { i, depth } of order) {
    if (opts.depth !== undefined && depth > opts.depth) {
      beyondDepth++;
      continue;
    }
    if (nodeEntries.length >= maxNodes) {
      beyondCap++;
      continue;
    }
    const n = nodes[i];
    const trs =
      n.matrix?.length === 16
        ? decompose(local[i])
        : { t: n.translation, r: n.rotation, s: n.scale };
    const light = (n.extensions?.KHR_lights_punctual as { light?: number } | undefined)?.light;
    const hiddenChildren =
      opts.depth !== undefined && depth === opts.depth ? n.children?.length : 0;
    nodeEntries.push({
      i,
      name: nodeLabel(i),
      parent: parent[i] >= 0 ? nodeLabel(parent[i]) : undefined,
      depth,
      t: nonDefault(trs.t, [0, 0, 0]),
      r: nonDefault(trs.r, [0, 0, 0, 1]),
      s: nonDefault(trs.s, [1, 1, 1]),
      fromMatrix: n.matrix ? true : undefined,
      mesh: n.mesh !== undefined ? meshLabel(n.mesh) : undefined,
      skin: n.skin,
      camera: n.camera,
      light,
      weights: n.weights ? round(n.weights) : undefined,
      extras: n.extras,
      childrenNotShown: hiddenChildren || undefined,
    });
  }
  if (beyondDepth) notes.push(`${beyondDepth} node(s) below depth ${opts.depth} are not listed.`);
  if (beyondCap) {
    notes.push(
      `The node list stops at ${maxNodes}; ${beyondCap} more are not listed. Scope to a subtree to see them.`,
    );
  }

  // ── Meshes and bounds ───────────────────────────────────────────────
  const skinMatrices = new Map<number, Promise<Mat4 | null>>();
  const skinBind = (si: number): Promise<Mat4 | null> => {
    let cached = skinMatrices.get(si);
    if (!cached) {
      cached = (async () => {
        const skin = json.skins?.[si];
        const joint = skin?.joints?.[0];
        if (!skin || joint === undefined || !nodes[joint]) return null;
        const ibm =
          skin.inverseBindMatrices !== undefined
            ? fromArray((await readAccessor(json, buffers, skin.inverseBindMatrices)).values)
            : identity();
        return multiply(worldOf(joint), ibm);
      })();
      skinMatrices.set(si, cached);
    }
    return cached;
  };

  const meshIndices = scoped
    ? unique(order.map(({ i }) => nodes[i].mesh).filter((m): m is number => m !== undefined))
    : (json.meshes ?? []).map((_, i) => i);
  const sceneMin: Vec3 = [Infinity, Infinity, Infinity];
  const sceneMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  const usedMaterials = new Set<number>();
  const meshEntries: GltfSummary[] = [];
  const compactMeshes = !scoped && meshIndices.length > COMPACT_MESHES_OVER;
  const meshCap = compactMeshes ? maxNodes : LIST_CAP;
  for (const mi of meshIndices.slice(0, meshCap)) {
    const mesh = json.meshes?.[mi];
    if (!mesh) continue;
    let vertices = 0;
    let triangles = 0;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const materials = new Set<string>();
    const attributes = new Set<string>();
    const modes = new Set<string>();
    let morphTargets = 0;
    let compression: string | undefined;
    for (const prim of mesh.primitives ?? []) {
      const posIndex = prim.attributes?.POSITION;
      const pos = posIndex !== undefined ? accessors[posIndex] : undefined;
      const vcount = pos?.count ?? 0;
      vertices += vcount;
      const icount = prim.indices !== undefined ? (accessors[prim.indices]?.count ?? 0) : vcount;
      const mode = prim.mode ?? 4;
      if (mode === 4) triangles += Math.floor(icount / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, icount - 2);
      else modes.add(MODE_NAMES[mode] ?? `mode ${mode}`);
      if (prim.material !== undefined) {
        materials.add(materialLabel(prim.material));
        usedMaterials.add(prim.material);
      } else {
        materials.add('(default)');
      }
      Object.keys(prim.attributes ?? {}).forEach((a) => attributes.add(a));
      morphTargets = Math.max(morphTargets, prim.targets?.length ?? 0);
      compression ??= Object.keys(prim.extensions ?? {}).find((k) => k.includes('compression'));

      let pmin = pos?.min;
      let pmax = pos?.max;
      if ((pmin?.length ?? 0) < 3 || (pmax?.length ?? 0) < 3) {
        pmin = pmax = undefined;
        if (posIndex !== undefined) {
          try {
            const data = await readAccessor(json, buffers, posIndex);
            const b = boundsOf(data.values, data.itemSize);
            if (b) [pmin, pmax] = [b.min, b.max];
          } catch (err) {
            notes.push(
              `${meshLabel(mi)}: POSITION has no min/max and could not be read (${errText(err)}).`,
            );
          }
        }
      } else if (pos?.normalized) {
        pmin = pmin!.map((v) => normalizeComponent(v, pos.componentType));
        pmax = pmax!.map((v) => normalizeComponent(v, pos.componentType));
      }
      if (pmin && pmax) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], pmin[k]);
          max[k] = Math.max(max[k], pmax[k]);
        }
      }
    }
    const hasBounds = min[0] <= max[0];

    const instances: GltfSummary[] = [];
    const instanceNodes = order.filter(({ i }) => nodes[i].mesh === mi).map(({ i }) => i);
    for (const ni of instanceNodes) {
      if (!hasBounds) break;
      let m = worldOf(ni);
      let skinned: true | undefined;
      const si = nodes[ni].skin;
      if (si !== undefined) {
        try {
          const bind = await skinBind(si);
          if (bind) {
            m = bind;
            skinned = true;
          }
        } catch (err) {
          notes.push(
            `${nodeLabel(ni)}: skin ${si} bind matrix unreadable (${errText(err)}); placed by its node instead.`,
          );
        }
      }
      const wb = transformBox(m, min, max);
      for (let k = 0; k < 3; k++) {
        sceneMin[k] = Math.min(sceneMin[k], wb.min[k]);
        sceneMax[k] = Math.max(sceneMax[k], wb.max[k]);
      }
      if (instances.length < INSTANCE_CAP) {
        instances.push({ node: nodeLabel(ni), ...box(wb.min, wb.max), skinned });
      }
    }

    if (compactMeshes) {
      const first = instances[0] as { size?: number[] } | undefined;
      meshEntries.push({
        i: mi,
        name: meshLabel(mi),
        vertices,
        triangles,
        materials: [...materials],
        size: first?.size ?? (hasBounds ? box(min, max).size : undefined),
        instances: instanceNodes.length !== 1 ? instanceNodes.length : undefined,
        morphTargets: morphTargets || undefined,
        compression,
      });
      continue;
    }
    meshEntries.push({
      i: mi,
      name: meshLabel(mi),
      primitives: mesh.primitives?.length ?? 0,
      vertices,
      triangles,
      nonTriangleModes: modes.size ? [...modes] : undefined,
      materials: [...materials],
      attributes: [...attributes],
      morphTargets: morphTargets || undefined,
      compression,
      local: hasBounds ? box(min, max) : undefined,
      world: instances.length ? instances : undefined,
      moreInstances:
        instanceNodes.length > INSTANCE_CAP ? instanceNodes.length - INSTANCE_CAP : undefined,
    });
  }
  if (meshIndices.length > meshCap) {
    notes.push(
      `The mesh list stops at ${meshCap}; ${meshIndices.length - meshCap} more are not listed.`,
    );
  }
  if (compactMeshes) {
    notes.push(
      `${meshIndices.length} meshes: each is one line with its world size (first instance). ` +
        'Scope to a subtree for local and per-instance world bounds.',
    );
  }
  if (json.extensionsUsed?.includes('KHR_mesh_quantization')) {
    notes.push(
      'KHR_mesh_quantization: local bounds are in quantized units; world bounds include the ' +
        'node transform that dequantizes them, so read sizes from those.',
    );
  }

  // ── Materials and images ───────────────────────────────────────────
  const tex = (info: GltfTextureInfo | undefined): string | undefined =>
    info?.index === undefined
      ? undefined
      : textureLabel(info.index) + (info.texCoord ? ` (uv${info.texCoord})` : '');
  const materialIndices = scoped
    ? [...usedMaterials].sort((a, b) => a - b)
    : (json.materials ?? []).map((_, i) => i);
  const materialEntries = materialIndices.slice(0, LIST_CAP).map((i) => {
    const m = json.materials![i];
    const pbr = m.pbrMetallicRoughness ?? {};
    return {
      i,
      name: materialLabel(i),
      baseColor: nonDefault(pbr.baseColorFactor, [1, 1, 1, 1]),
      baseColorMap: tex(pbr.baseColorTexture),
      metallic: round1(pbr.metallicFactor ?? 1),
      roughness: round1(pbr.roughnessFactor ?? 1),
      metallicRoughnessMap: tex(pbr.metallicRoughnessTexture),
      normalMap: tex(m.normalTexture),
      occlusionMap: tex(m.occlusionTexture),
      emissive: nonDefault(m.emissiveFactor, [0, 0, 0]),
      emissiveMap: tex(m.emissiveTexture),
      alphaMode: m.alphaMode && m.alphaMode !== 'OPAQUE' ? m.alphaMode : undefined,
      alphaCutoff: m.alphaMode === 'MASK' ? (m.alphaCutoff ?? 0.5) : undefined,
      doubleSided: m.doubleSided || undefined,
      extensions: m.extensions ? Object.keys(m.extensions) : undefined,
    };
  });

  const imageEntries: GltfSummary[] = [];
  if (!scoped) {
    for (const [i, im] of (json.images ?? []).slice(0, LIST_CAP).entries()) {
      let data: Uint8Array | null = null;
      try {
        if (im.bufferView !== undefined) data = await buffers.bufferView(im.bufferView);
        else if (im.uri) data = await buffers.uri(im.uri);
      } catch (err) {
        notes.push(`${imageLabel(i)}: ${errText(err)}`);
      }
      const header = data ? readImageHeader(data) : null;
      imageEntries.push({
        i,
        name: imageLabel(i),
        mimeType: im.mimeType ?? header?.mimeType,
        width: header?.width,
        height: header?.height,
        bytes: data?.length,
        uri: im.uri && !im.uri.startsWith('data:') ? im.uri : undefined,
      });
    }
  }

  // ── Animations ─────────────────────────────────────────────────────
  interface Channel {
    node?: number;
    target: string;
    path: string;
    input?: number;
    output?: number;
    interpolation: string;
  }
  const channelsOf = (ci: number): Channel[] => {
    const clip = clips[ci];
    const out: Channel[] = [];
    for (const ch of clip.channels ?? []) {
      const node = ch.target?.node;
      if (scoped && (node === undefined || !inScope.has(node))) continue;
      const sampler = ch.sampler !== undefined ? clip.samplers?.[ch.sampler] : undefined;
      const pointer = ch.target?.extensions?.KHR_animation_pointer?.pointer;
      out.push({
        node,
        target: node !== undefined ? nodeLabel(node) : (pointer ?? '(no target)'),
        path: ch.target?.path ?? 'pointer',
        input: sampler?.input,
        output: sampler?.output,
        interpolation: sampler?.interpolation ?? 'LINEAR',
      });
    }
    return out;
  };
  const allChannels = clips.map((_, ci) => channelsOf(ci));
  const channelTotal = allChannels.reduce((sum, c) => sum + c.length, 0);
  const withStats = scoped || channelTotal <= CHANNEL_STATS_LIMIT;

  const decodeTrack = async (ch: Channel) => {
    if (ch.input === undefined || ch.output === undefined)
      throw new GltfError('channel has no sampler.');
    const input = await readAccessor(json, buffers, ch.input);
    const output = await readAccessor(json, buffers, ch.output);
    const keys = input.count;
    const cubic = ch.interpolation === 'CUBICSPLINE';
    const width = keys ? (output.count * output.itemSize) / keys / (cubic ? 3 : 1) : 0;
    const value = (k: number) => {
      const start = (k * (cubic ? 3 : 1) + (cubic ? 1 : 0)) * width;
      return Array.from(output.values.subarray(start, start + width));
    };
    return { times: input.values, keys, width, value };
  };

  const animationEntries: GltfSummary[] = [];
  for (const [ci, clip] of clips.entries()) {
    const channels = allChannels[ci];
    if (scoped && channels.length === 0) continue;
    let start = Infinity;
    let end = -Infinity;
    const paths: Record<string, number> = {};
    const interpolation = new Set<string>();
    const targets = new Set<string>();
    for (const ch of channels) {
      paths[ch.path] = (paths[ch.path] ?? 0) + 1;
      interpolation.add(ch.interpolation);
      targets.add(ch.target);
    }
    // Duration over every channel, not only the scoped ones: it is the clip's length.
    for (const s of clip.samplers ?? []) {
      const input = s.input !== undefined ? accessors[s.input] : undefined;
      if (input?.min?.length && input.max?.length) {
        start = Math.min(start, input.min[0]);
        end = Math.max(end, input.max[0]);
      }
    }
    let channelStats: GltfSummary[] | undefined;
    if (withStats) {
      channelStats = [];
      for (const ch of channels) {
        try {
          const track = await decodeTrack(ch);
          if (!track.keys) {
            channelStats.push({ node: ch.target, path: ch.path, keys: 0 });
            continue;
          }
          const first = track.value(0);
          const last = track.value(track.keys - 1);
          const stat: GltfSummary = {
            node: ch.target,
            path: ch.path,
            keys: track.keys,
            interpolation: ch.interpolation !== 'LINEAR' ? ch.interpolation : undefined,
            first: round(first),
            last: round(last),
          };
          if (ch.path === 'rotation' && track.width === 4) {
            let swing = 0;
            for (let k = 1; k < track.keys; k++)
              swing = Math.max(swing, quatAngleDeg(first, track.value(k)));
            stat.maxDegFromFirst = round1(swing);
          } else {
            const lo = first.slice();
            const hi = first.slice();
            for (let k = 1; k < track.keys; k++) {
              track.value(k).forEach((v, j) => {
                lo[j] = Math.min(lo[j], v);
                hi[j] = Math.max(hi[j], v);
              });
            }
            stat.min = round(lo);
            stat.max = round(hi);
          }
          channelStats.push(stat);
        } catch (err) {
          channelStats.push({ node: ch.target, path: ch.path, error: errText(err) });
        }
      }
    }
    animationEntries.push({
      i: ci,
      name: clipLabel(ci),
      duration: end > -Infinity ? round1(end) : undefined,
      start: start > 0 && start < Infinity ? round1(start) : undefined,
      channels: channels.length,
      nodes: targets.size,
      paths,
      interpolation: [...interpolation],
      channelStats,
    });
  }
  if (!withStats && channelTotal > 0) {
    notes.push(
      `${channelTotal} animation channels: per-channel keyframe stats are shown only for a scoped ` +
        'read (a node subtree), to keep this summary small.',
    );
  }

  let keyframes: GltfSummary | undefined;
  if (opts.keys !== undefined) {
    const ci = resolveByName(
      clips.map((a) => a.name),
      opts.keys,
      'animation',
    );
    let budget = opts.maxKeyValues ?? DEFAULT_MAX_KEY_VALUES;
    const tracks: GltfSummary[] = [];
    for (const ch of allChannels[ci]) {
      try {
        if (budget <= 0) {
          tracks.push({ node: ch.target, path: ch.path, omitted: 'value budget spent' });
          continue;
        }
        const track = await decodeTrack(ch);
        const rows = Math.min(track.keys, Math.floor(budget / (track.width + 1)));
        if (rows === 0 && track.keys > 0) {
          budget = 0;
          tracks.push({ node: ch.target, path: ch.path, omitted: 'value budget spent' });
          continue;
        }
        const keys: number[][] = [];
        for (let k = 0; k < rows; k++) keys.push(round([track.times[k], ...track.value(k)]));
        budget -= rows * (track.width + 1);
        tracks.push({
          node: ch.target,
          path: ch.path,
          interpolation: ch.interpolation !== 'LINEAR' ? ch.interpolation : undefined,
          keysNotShown: rows < track.keys ? track.keys - rows : undefined,
          keys,
        });
      } catch (err) {
        tracks.push({ node: ch.target, path: ch.path, error: errText(err) });
      }
    }
    if (budget <= 0) {
      notes.push('Keyframes stop at the value budget; scope to a subtree for the rest.');
    }
    if (tracks.length === 0) {
      const keyed = unique(
        (clips[ci].channels ?? [])
          .map((c) => c.target?.node)
          .filter((n): n is number => n !== undefined),
      );
      notes.push(
        `${clipLabel(ci)} keys nothing ${scoped ? `under ${nodeLabel(scopeRoot)}` : 'at all'}` +
          (keyed.length ? `; it keys: ${keyed.slice(0, 20).map(nodeLabel).join(', ')}.` : '.'),
      );
    }
    keyframes = {
      animation: clipLabel(ci),
      layout: '[time, ...value] per row; CUBICSPLINE rows carry the value, not its tangents',
      tracks,
    };
  }

  // ── Skins, cameras, lights ─────────────────────────────────────────
  const skinIndices = scoped
    ? unique(order.map(({ i }) => nodes[i].skin).filter((s): s is number => s !== undefined))
    : (json.skins ?? []).map((_, i) => i);
  const skinEntries = skinIndices.map((i) => {
    const skin = json.skins![i];
    return {
      i,
      name: skin.name,
      joints: skin.joints?.length ?? 0,
      rootJoint: skin.joints?.length ? nodeLabel(skin.joints[0]) : undefined,
      skeleton: skin.skeleton !== undefined ? nodeLabel(skin.skeleton) : undefined,
    };
  });
  const cameraEntries = scoped
    ? []
    : (json.cameras ?? []).map((c, i) => ({
        i,
        name: c.name,
        type: c.type,
        yfovDeg:
          c.perspective?.yfov !== undefined
            ? round1((c.perspective.yfov * 180) / Math.PI)
            : undefined,
        aspect: c.perspective?.aspectRatio,
        xmag: c.orthographic?.xmag,
        ymag: c.orthographic?.ymag,
        znear: c.perspective?.znear ?? c.orthographic?.znear,
        zfar: c.perspective?.zfar ?? c.orthographic?.zfar,
      }));
  const lights = scoped
    ? []
    : (
        ((
          json.extensions?.KHR_lights_punctual as
            | { lights?: Array<Record<string, unknown>> }
            | undefined
        )?.lights ?? []) as Array<Record<string, unknown>>
      ).map((l, i) => ({ i, ...l }));

  const hasSceneBounds = sceneMin[0] <= sceneMax[0];
  return {
    format,
    bytes: bytes.length,
    version: json.asset?.version,
    generator: json.asset?.generator,
    copyright: json.asset?.copyright,
    extensionsUsed: json.extensionsUsed?.length ? json.extensionsUsed : undefined,
    extensionsRequired: json.extensionsRequired?.length ? json.extensionsRequired : undefined,
    units: 'metres; +Y up; the asset front faces +Z',
    scope: scoped ? { node: nodeLabel(scopeRoot), depth: opts.depth } : undefined,
    counts: {
      nodes: nodes.length,
      meshes: json.meshes?.length ?? 0,
      materials: json.materials?.length ?? 0,
      images: json.images?.length ?? 0,
      animations: clips.length,
      skins: json.skins?.length ?? 0,
      cameras: json.cameras?.length ?? 0,
    },
    bounds: hasSceneBounds
      ? {
          ...box(sceneMin, sceneMax),
          center: round(sceneMin.map((v, k) => (v + sceneMax[k]) / 2)),
          of: scoped ? 'the subtree, rest pose' : 'the default scene, rest pose',
        }
      : undefined,
    nodes: nodeEntries,
    meshes: meshEntries,
    materials: materialEntries.length ? materialEntries : undefined,
    images: imageEntries.length ? imageEntries : undefined,
    animations: animationEntries.length ? animationEntries : undefined,
    keyframes,
    skins: skinEntries.length ? skinEntries : undefined,
    cameras: cameraEntries.length ? cameraEntries : undefined,
    lights: lights.length ? lights : undefined,
    notes: notes.length ? notes : undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Display names: the name when unique, `name#i` when shared, `#i` when absent. */
function labeler(names: Array<string | undefined>): (i: number) => string {
  const seen = new Map<string, number>();
  for (const n of names) if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  return (i) => {
    const n = names[i];
    if (!n) return `#${i}`;
    return seen.get(n)! > 1 ? `${n}#${i}` : n;
  };
}

/** Exact name, then case-insensitive, then an index (`12`, `#12`), then a unique substring. */
function resolveByName(
  names: Array<string | undefined>,
  query: string | number,
  kind: string,
): number {
  const q = String(query).trim();
  const pick = (matches: number[]): number | undefined => {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new GltfError(
        `"${q}" matches ${matches.length} ${kind}s: ${matches
          .slice(0, 10)
          .map((i) => `${names[i]} (#${i})`)
          .join(', ')}. Pass "#<index>" to pick one.`,
      );
    }
    return undefined;
  };
  const all = names.map((_, i) => i);
  const lower = q.toLowerCase();
  const found =
    pick(all.filter((i) => names[i] === q)) ??
    pick(all.filter((i) => names[i]?.toLowerCase() === lower)) ??
    (/^#?\d+$/.test(q) && Number(q.replace('#', '')) < names.length
      ? Number(q.replace('#', ''))
      : undefined) ??
    pick(all.filter((i) => names[i]?.toLowerCase().includes(lower)));
  if (found !== undefined) return found;
  const known = names.filter(Boolean).slice(0, 20);
  throw new GltfError(
    `No ${kind} matches "${q}".` +
      (known.length
        ? ` ${kind}s include: ${known.join(', ')}${names.length > 20 ? ', …' : ''}.`
        : ` The file has no named ${kind}s.`),
  );
}

function vec3(v: number[] | undefined, fill: number): Vec3 {
  return v?.length === 3 ? [v[0], v[1], v[2]] : [fill, fill, fill];
}

function quat(v: number[] | undefined): Quat {
  return v?.length === 4 ? [v[0], v[1], v[2], v[3]] : [0, 0, 0, 1];
}

function box(min: ArrayLike<number>, max: ArrayLike<number>) {
  return {
    min: round(Array.from(min)),
    max: round(Array.from(max)),
    size: round([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
  };
}

function boundsOf(values: Float64Array, itemSize: number): { min: Vec3; max: Vec3 } | null {
  if (itemSize < 3 || values.length < itemSize) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += itemSize) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], values[i + k]);
      max[k] = Math.max(max[k], values[i + k]);
    }
  }
  return { min, max };
}

/** The values rounded, or undefined when they equal the default (and so say nothing). */
function nonDefault(v: ArrayLike<number> | undefined, def: number[]): number[] | undefined {
  if (!v || v.length !== def.length) return undefined;
  const rounded = round(Array.from(v));
  return rounded.every((x, i) => x === def[i]) ? undefined : rounded;
}

/** Six significant digits: past that, float32 storage is noise anyway. */
function round1(x: number): number {
  if (!Number.isFinite(x)) return x;
  // Float noise around zero (a cosine of 90°, a subtraction that should cancel) reads as a
  // real offset in exponent form; nothing in a scene is a nanometre.
  if (Math.abs(x) < 1e-9) return 0;
  const r = Number(x.toPrecision(6));
  return r === 0 ? 0 : r;
}

function round(values: number[]): number[] {
  return values.map(round1);
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
