/**
 * A glTF file described as data a reader can act on: the node tree with local TRS, every mesh
 * with its local and world bounds, materials, image sizes, and what each animation clip keys.
 *
 * Structure and bounds come from the JSON alone (POSITION and animation-input `min`/`max` are
 * required by the spec). The binary payload is touched only for what lives nowhere else:
 * per-channel keyframe statistics, full keyframes on request, a skin's bind matrix, and the
 * first bytes of each image.
 *
 * Nothing here renders or loads textures. Bounds are the rest pose unless `pose` plays a clip
 * (`animate.ts` evaluates its samplers as a player would): then nodes are placed in world space
 * at that time, parents included, and a skinned mesh is skinned vertex by vertex. At rest a
 * skinned mesh is placed by its first joint's bind matrix — the answer a loader would give
 * before its first frame. Morph targets are ignored throughout.
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
  quatToEulerDeg,
  sameMatrix,
  transformBox,
  transformPoint,
  type Mat4,
  type Quat,
  type Vec3,
} from './matrix.js';
import { readImageHeader } from './image-size.js';
import { decodeTrack, findJumps, sampleTimes, unwrapDegrees, type Track } from './animate.js';

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
  /**
   * An animation (name or index) to play: with `at`, every listed node's world transform and
   * the posed mesh bounds at that time; without `at`, the world path of the `node` scope root
   * sampled over the clip.
   */
  pose?: string | number;
  /** Seconds into the `pose` clip to take the snapshot at. */
  at?: number;
  /**
   * A time window, `[from, to]` or `"0.2-0.8"` (either end may be left open): `keys` returns
   * only the keys inside it, and a `pose` path samples only across it.
   */
  range?: [number, number] | string;
  /**
   * Resample instead of listing raw keys: `keys` rows land every `step` seconds, evaluated as
   * a player would, and a `pose` path uses it as its sample interval.
   */
  step?: number;
  /** Rotations as XYZ Euler degrees (three.js's default order) instead of quaternions. */
  euler?: boolean;
  /** Top-level sections to leave out: `nodes`, `meshes`, `materials`, `images`, `animations`… */
  omit?: string[] | string;
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
/** Sections `omit` can drop. The header, `bounds`, `keyframes`, `pose` and notes always stay. */
const OMITTABLE = [
  'nodes',
  'meshes',
  'materials',
  'images',
  'animations',
  'skins',
  'cameras',
  'lights',
] as const;
/** A `pose` path without `step` takes this many intervals across its window. */
const PATH_INTERVALS = 20;
/** Samples a `step` may ask for, per track or path, before it is refused as a typo. */
const MAX_SAMPLES = 5_000;
/** Vertices a posed skinned instance is skinned for exactly; past this it is left unposed. */
const MAX_SKINNED_VERTICES = 2_000_000;
const JUMPS_SHOWN = 8;
/** Key times are float32 while `min`/`max` and a caller's range are decimal: 1.2 ≠ 1.2f. */
const TIME_EPSILON = 1e-5;

export async function summarizeGltf(
  bytes: Uint8Array,
  opts: GltfSummaryOptions = {},
): Promise<GltfSummary> {
  const { format, json, bin } = parseGltfContainer(bytes);
  const buffers = new GltfBuffers(json, bin, opts.resolveUri);
  const notes: string[] = [];
  const omit = parseOmit(opts.omit);
  const range = parseRange(opts.range);
  if (opts.step !== undefined && !(opts.step > 0)) {
    throw new GltfError(`step must be a positive number of seconds, not ${opts.step}.`);
  }
  if (opts.at !== undefined && opts.pose === undefined) {
    throw new GltfError('`at` is a time in the `pose` clip — name the clip with `pose` too.');
  }
  /** A rotation as the caller asked to read it. */
  const rot = (q: ArrayLike<number>): number[] => (opts.euler ? quatToEulerDeg(q) : Array.from(q));
  /** A channel value for display: rotations follow `euler`, everything else as stored. */
  const shown = (path: string, v: number[]): number[] =>
    path === 'rotation' && v.length === 4 ? round(rot(v)) : round(v);
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
  /** The node indices the list shows, in its order — what a posed snapshot reports on. */
  const listed: number[] = [];
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
    listed.push(i);
    nodeEntries.push({
      i,
      name: nodeLabel(i),
      parent: parent[i] >= 0 ? nodeLabel(parent[i]) : undefined,
      depth,
      t: nonDefault(trs.t, [0, 0, 0]),
      r: opts.euler ? undefined : nonDefault(trs.r, [0, 0, 0, 1]),
      rDeg: opts.euler && trs.r ? nonDefault(quatToEulerDeg(trs.r), [0, 0, 0]) : undefined,
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
  const inverseBinds = new Map<number, Promise<Mat4[]>>();
  const inverseBindsOf = (si: number): Promise<Mat4[]> => {
    let cached = inverseBinds.get(si);
    if (!cached) {
      cached = (async () => {
        const skin = json.skins?.[si];
        const joints = skin?.joints ?? [];
        if (skin?.inverseBindMatrices === undefined) return joints.map(() => identity());
        const data = await readAccessor(json, buffers, skin.inverseBindMatrices);
        return joints.map((_, k) => fromArray(data.values, k * 16));
      })();
      inverseBinds.set(si, cached);
    }
    return cached;
  };
  /** A skinned mesh's rest placement: its first joint's world matrix times its bind inverse. */
  const skinBind = async (si: number): Promise<Mat4 | null> => {
    const joint = json.skins?.[si]?.joints?.[0];
    if (joint === undefined || !nodes[joint]) return null;
    return multiply(worldOf(joint), (await inverseBindsOf(si))[0] ?? identity());
  };

  const meshIndices = scoped
    ? unique(order.map(({ i }) => nodes[i].mesh).filter((m): m is number => m !== undefined))
    : (json.meshes ?? []).map((_, i) => i);
  const sceneMin: Vec3 = [Infinity, Infinity, Infinity];
  const sceneMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  const usedMaterials = new Set<number>();
  /** Each listed mesh's local (rest, unskinned) box — what a pose moves. */
  const meshLocal = new Map<number, { min: Vec3; max: Vec3 }>();
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
    if (hasBounds) meshLocal.set(mi, { min, max });

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
        extras: mesh.extras,
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
      extras: mesh.extras,
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
      extras: m.extras,
    };
  });

  const imageEntries: GltfSummary[] = [];
  if (!scoped && !omit.has('images')) {
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
  /** A clip's channels — only the scope's unless `everywhere` (a pose needs the parents too). */
  const channelsOf = (ci: number, everywhere = false): Channel[] => {
    const clip = clips[ci];
    const out: Channel[] = [];
    for (const ch of clip.channels ?? []) {
      const node = ch.target?.node;
      if (scoped && !everywhere && (node === undefined || !inScope.has(node))) continue;
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
  const withStats = !omit.has('animations') && (scoped || channelTotal <= CHANNEL_STATS_LIMIT);

  const tracks = new Map<string, Promise<Track>>();
  const loadTrack = (ch: Channel): Promise<Track> => {
    const { input, output } = ch;
    if (input === undefined || output === undefined) {
      return Promise.reject(new GltfError('channel has no sampler.'));
    }
    const key = `${input}:${output}:${ch.interpolation}:${ch.path}`;
    let cached = tracks.get(key);
    if (!cached) {
      cached = (async () =>
        decodeTrack(
          await readAccessor(json, buffers, input),
          await readAccessor(json, buffers, output),
          ch.interpolation,
          ch.path,
        ))();
      tracks.set(key, cached);
    }
    return cached;
  };
  /** A clip's time span over every sampler, scoped or not: it is the clip's length. */
  const clipSpan = (ci: number): { start: number; end: number; known: boolean } => {
    let start = Infinity;
    let end = -Infinity;
    for (const s of clips[ci].samplers ?? []) {
      const input = s.input !== undefined ? accessors[s.input] : undefined;
      if (input?.min?.length && input.max?.length) {
        start = Math.min(start, input.min[0]);
        end = Math.max(end, input.max[0]);
      }
    }
    return end > -Infinity ? { start, end, known: true } : { start: 0, end: 0, known: false };
  };
  /** A track's near-instant changes, with what a scale jump does to visibility. */
  const jumpsOf = (ch: Channel, track: Track, from = -Infinity, to = Infinity) => {
    const all = findJumps(track).filter(
      (j) => j.at >= from - TIME_EPSILON && j.at <= to + TIME_EPSILON,
    );
    if (!all.length) return {};
    return {
      jumps: all.slice(0, JUMPS_SHOWN).map((j) => ({
        at: round1(j.at),
        dt: roundDt(j.dt),
        to: shown(ch.path, j.to),
        effect: ch.path === 'scale' ? visibilityChange(j.from, j.to) : undefined,
      })),
      moreJumps: all.length > JUMPS_SHOWN ? all.length - JUMPS_SHOWN : undefined,
    };
  };

  const animationEntries: GltfSummary[] = [];
  for (const [ci, clip] of omit.has('animations') ? [] : clips.entries()) {
    const channels = allChannels[ci];
    if (scoped && channels.length === 0) continue;
    const paths: Record<string, number> = {};
    const interpolation = new Set<string>();
    const targets = new Set<string>();
    for (const ch of channels) {
      paths[ch.path] = (paths[ch.path] ?? 0) + 1;
      interpolation.add(ch.interpolation);
      targets.add(ch.target);
    }
    const { start, end, known } = clipSpan(ci);
    let channelStats: GltfSummary[] | undefined;
    if (withStats) {
      channelStats = [];
      for (const ch of channels) {
        try {
          const track = await loadTrack(ch);
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
            first: shown(ch.path, first),
            last: shown(ch.path, last),
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
          channelStats.push({ ...stat, ...jumpsOf(ch, track) });
        } catch (err) {
          channelStats.push({ node: ch.target, path: ch.path, error: errText(err) });
        }
      }
    }
    animationEntries.push({
      i: ci,
      name: clipLabel(ci),
      duration: known ? round1(end) : undefined,
      start: known && start > 0 ? round1(start) : undefined,
      channels: channels.length,
      nodes: targets.size,
      paths,
      interpolation: [...interpolation],
      extras: clip.extras,
      channelStats,
    });
  }
  if (!withStats && channelTotal > 0 && !omit.has('animations')) {
    notes.push(
      `${channelTotal} animation channels: per-channel keyframe stats are shown only for a scoped ` +
        'read (a node subtree), to keep this summary small.',
    );
  }

  /** The window a keys or path read covers: `range` clipped to nothing, else the whole clip. */
  const windowOf = (ci: number): [number, number] => {
    const span = clipSpan(ci);
    const from = range?.[0] ?? span.start;
    const to = range?.[1] ?? span.end;
    if (to < from) throw new GltfError(`range ends (${to}) before it starts (${from}).`);
    return [from, to];
  };
  const samplesOver = (from: number, to: number, step: number): number[] => {
    if ((to - from) / step > MAX_SAMPLES) {
      throw new GltfError(
        `step ${step} over ${round1(to - from)} s is more than ${MAX_SAMPLES} samples; ` +
          'use a larger step or a narrower range.',
      );
    }
    return sampleTimes(from, to, step);
  };
  /** `[time, ...value]` rows, rotations continuous when shown as Euler angles. */
  const rowsOf = (path: string, times: number[], values: number[][]): number[][] => {
    const euler = opts.euler && path === 'rotation' && values[0]?.length === 4;
    const rows = times.map((t, r) => [t, ...(euler ? quatToEulerDeg(values[r]) : values[r])]);
    if (euler) unwrapDegrees(rows, 1, 3);
    return rows.map(round);
  };

  let keyframes: GltfSummary | undefined;
  if (opts.keys !== undefined) {
    const ci = resolveByName(
      clips.map((a) => a.name),
      opts.keys,
      'animation',
    );
    const [from, to] = windowOf(ci);
    let budget = opts.maxKeyValues ?? DEFAULT_MAX_KEY_VALUES;
    const trackEntries: GltfSummary[] = [];
    for (const ch of allChannels[ci]) {
      try {
        if (budget <= 0) {
          trackEntries.push({ node: ch.target, path: ch.path, omitted: 'value budget spent' });
          continue;
        }
        const track = await loadTrack(ch);
        let times: number[];
        let values: number[][];
        if (opts.step !== undefined) {
          times = samplesOver(from, to, opts.step);
          values = times.map((t) => track.sample(t));
        } else {
          times = [];
          values = [];
          for (let k = 0; k < track.keys; k++) {
            const t = track.times[k];
            if (range && (t < from - TIME_EPSILON || t > to + TIME_EPSILON)) continue;
            times.push(t);
            values.push(track.value(k));
          }
        }
        const width = values[0]?.length ?? track.width;
        const rows = Math.min(times.length, Math.floor(budget / (width + 1)));
        if (rows === 0 && times.length > 0) {
          budget = 0;
          trackEntries.push({ node: ch.target, path: ch.path, omitted: 'value budget spent' });
          continue;
        }
        budget -= rows * (width + 1);
        trackEntries.push({
          node: ch.target,
          path: ch.path,
          interpolation: ch.interpolation !== 'LINEAR' ? ch.interpolation : undefined,
          keysNotShown: rows < times.length ? times.length - rows : undefined,
          ...jumpsOf(ch, track, from, to),
          keys: rowsOf(ch.path, times.slice(0, rows), values.slice(0, rows)),
        });
      } catch (err) {
        trackEntries.push({ node: ch.target, path: ch.path, error: errText(err) });
      }
    }
    if (budget <= 0) {
      notes.push(
        'Keyframes stop at the value budget; scope to a subtree, narrow the range, or resample ' +
          'with a step for the rest.',
      );
    }
    if (trackEntries.length === 0) {
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
      window: range ? round([from, to]) : undefined,
      layout:
        opts.step !== undefined
          ? `[time, ...value] every ${opts.step} s, interpolated as a player would`
          : '[time, ...value] per row; CUBICSPLINE rows carry the value, not its tangents',
      tracks: trackEntries,
    };
  }

  // ── Pose ───────────────────────────────────────────────────────────
  /**
   * A skinned instance's exact posed box: every vertex through its weighted joint matrices,
   * as the GPU would skin it (JOINTS_0/WEIGHTS_0; morph targets still ignored).
   */
  const skinnedBox = async (
    mi: number,
    si: number,
    worldAt: (i: number) => Mat4,
  ): Promise<{ min: Vec3; max: Vec3 } | null> => {
    const joints = json.skins?.[si]?.joints ?? [];
    const ibms = await inverseBindsOf(si);
    const jointMats = joints.map((j, k) => multiply(worldAt(j), ibms[k] ?? identity()));
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const prim of json.meshes?.[mi]?.primitives ?? []) {
      const a = prim.attributes ?? {};
      if (a.POSITION === undefined || a.JOINTS_0 === undefined || a.WEIGHTS_0 === undefined) {
        return null;
      }
      if ((accessors[a.POSITION]?.count ?? 0) > MAX_SKINNED_VERTICES) return null;
      const pos = await readAccessor(json, buffers, a.POSITION);
      const jnt = await readAccessor(json, buffers, a.JOINTS_0);
      const wgt = await readAccessor(json, buffers, a.WEIGHTS_0);
      for (let v = 0; v < pos.count; v++) {
        const p: Vec3 = [pos.values[v * 3], pos.values[v * 3 + 1], pos.values[v * 3 + 2]];
        const out: Vec3 = [0, 0, 0];
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const w = wgt.values[v * 4 + k];
          const m = jointMats[jnt.values[v * 4 + k]];
          if (!w || !m) continue;
          const q = transformPoint(m, p);
          out[0] += w * q[0];
          out[1] += w * q[1];
          out[2] += w * q[2];
          total += w;
        }
        if (!total) continue;
        for (let k = 0; k < 3; k++) {
          const c = out[k] / total;
          if (c < min[k]) min[k] = c;
          if (c > max[k]) max[k] = c;
        }
      }
    }
    return min[0] <= max[0] ? { min, max } : null;
  };

  let pose: GltfSummary | undefined;
  if (opts.pose !== undefined) {
    const ci = resolveByName(
      clips.map((a) => a.name),
      opts.pose,
      'animation',
    );
    const span = clipSpan(ci);
    // Every channel the clip has, scoped or not: an animated parent moves the subtree too.
    const posers: Array<{ node: number; path: string; track: Track; ch: Channel }> = [];
    for (const ch of channelsOf(ci, true)) {
      if (ch.node === undefined || !nodes[ch.node]) continue;
      if (ch.path !== 'translation' && ch.path !== 'rotation' && ch.path !== 'scale') continue;
      try {
        posers.push({ node: ch.node, path: ch.path, track: await loadTrack(ch), ch });
      } catch (err) {
        notes.push(`${clipLabel(ci)}: ${ch.target} ${ch.path} is unreadable (${errText(err)}).`);
      }
    }
    const animated = new Set(posers.map((p) => p.node));
    const rest = nodes.map((n, i) =>
      n.matrix?.length === 16
        ? decompose(local[i])
        : { t: vec3(n.translation, 0), r: quat(n.rotation), s: vec3(n.scale, 1) },
    );
    /** World matrices at `t`, computed only for the nodes asked about and their parents. */
    const poseAt = (t: number): ((i: number) => Mat4) => {
      const trs = new Map<number, { t: Vec3; r: Quat; s: Vec3 }>();
      for (const { node, path, track } of posers) {
        const v = track.sample(t);
        const cur = trs.get(node) ?? { ...rest[node] };
        if (path === 'translation' && v.length === 3) cur.t = [v[0], v[1], v[2]];
        else if (path === 'rotation' && v.length === 4) cur.r = [v[0], v[1], v[2], v[3]];
        else if (path === 'scale' && v.length === 3) cur.s = [v[0], v[1], v[2]];
        trs.set(node, cur);
      }
      const out: Array<Mat4 | undefined> = [];
      const get = (i: number, guard = 0): Mat4 => {
        const cached = out[i];
        if (cached) return cached;
        const x = trs.get(i);
        const loc = x ? compose(x.t, x.r, x.s) : local[i];
        const p = parent[i];
        const m = p < 0 || guard > nodes.length ? loc : multiply(get(p, guard + 1), loc);
        out[i] = m;
        return m;
      };
      return get;
    };
    const chainOf = (i: number): number[] => {
      const chain: number[] = [];
      for (let n = i, g = 0; n >= 0 && g <= nodes.length; n = parent[n], g++) chain.push(n);
      return chain;
    };
    const trsOut = (m: Mat4) => {
      const d = decompose(m);
      return {
        t: round(d.t),
        r: opts.euler ? undefined : round(d.r),
        rDeg: opts.euler ? round(quatToEulerDeg(d.r)) : undefined,
        s: nonDefault(d.s, [1, 1, 1]),
      };
    };

    if (opts.at !== undefined) {
      const at = opts.at;
      if (at < span.start || at > span.end) {
        notes.push(
          `at ${at} s is outside ${clipLabel(ci)} (${round1(span.start)}–${round1(span.end)} s); ` +
            'every channel holds its nearest key.',
        );
      }
      const posed = poseAt(at);
      const moved = (i: number) => !sameMatrix(posed(i), worldOf(i));
      const shownNodes = scoped ? listed : listed.filter(moved);
      if (!scoped && listed.length > shownNodes.length) {
        notes.push(
          `The pose lists the ${shownNodes.length} node(s) this clip moves at ${at} s; the other ` +
            `${listed.length - shownNodes.length} sit where they rest.`,
        );
      }
      const poseMin: Vec3 = [Infinity, Infinity, Infinity];
      const poseMax: Vec3 = [-Infinity, -Infinity, -Infinity];
      const instances: GltfSummary[] = [];
      let movedInstances = 0;
      for (const { i: ni } of order) {
        const mi = nodes[ni].mesh;
        const lb = mi !== undefined ? meshLocal.get(mi) : undefined;
        if (mi === undefined || !lb) continue;
        const si = nodes[ni].skin;
        let wb: { min: Vec3; max: Vec3 } | null = null;
        let skinned: true | undefined;
        let changed = false;
        if (si !== undefined && json.skins?.[si]) {
          const joints = json.skins[si].joints ?? [];
          changed = joints.some((j) => nodes[j] && moved(j));
          try {
            wb = await skinnedBox(mi, si, posed);
            skinned = wb ? true : undefined;
          } catch (err) {
            notes.push(`${nodeLabel(ni)}: could not skin for the pose (${errText(err)}).`);
          }
          if (!wb) {
            notes.push(
              `${nodeLabel(ni)}: skinned mesh without readable JOINTS_0/WEIGHTS_0 (or too many ` +
                'vertices); its posed box follows its first joint only.',
            );
            const ibms = await inverseBindsOf(si).catch(() => [identity()]);
            const j0 = joints[0];
            const m = j0 !== undefined ? multiply(posed(j0), ibms[0] ?? identity()) : posed(ni);
            wb = transformBox(m, lb.min, lb.max);
          }
        } else {
          changed = moved(ni);
          wb = transformBox(posed(ni), lb.min, lb.max);
        }
        for (let k = 0; k < 3; k++) {
          poseMin[k] = Math.min(poseMin[k], wb.min[k]);
          poseMax[k] = Math.max(poseMax[k], wb.max[k]);
        }
        if (!changed) continue;
        movedInstances++;
        if (instances.length < LIST_CAP) {
          instances.push({
            node: nodeLabel(ni),
            mesh: meshLabel(mi),
            ...box(wb.min, wb.max),
            skinned,
          });
        }
      }
      pose = {
        animation: clipLabel(ci),
        at,
        of: 'world space; each node as the clip places it, parents included',
        bounds: poseMin[0] <= poseMax[0] ? box(poseMin, poseMax) : undefined,
        nodes: shownNodes.map((i) => ({
          node: nodeLabel(i),
          ...trsOut(posed(i)),
          keyed: animated.has(i) || undefined,
        })),
        movedMeshes: instances.length ? instances : undefined,
        moreMovedMeshes:
          movedInstances > instances.length ? movedInstances - instances.length : undefined,
      };
    } else {
      if (scopeRoot === undefined) {
        throw new GltfError(
          "`pose` without `at` samples one node's world path — name that node with `node`, " +
            'or pass `at` for a snapshot of the whole model.',
        );
      }
      const [from, to] = windowOf(ci);
      const step = opts.step ?? ((to - from) / PATH_INTERVALS || 1);
      const times = samplesOver(from, to, step);
      const chain = chainOf(scopeRoot);
      const rows = times.map((t) => {
        const d = decompose(poseAt(t)(scopeRoot));
        return [
          t,
          ...d.t,
          ...(opts.euler ? quatToEulerDeg(d.r) : d.r),
          Math.max(Math.abs(d.s[0]), Math.abs(d.s[1]), Math.abs(d.s[2])),
        ];
      });
      if (opts.euler) unwrapDegrees(rows, 4, 3);
      const lo: Vec3 = [Infinity, Infinity, Infinity];
      const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const r of rows) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], r[1 + k]);
          hi[k] = Math.max(hi[k], r[1 + k]);
        }
      }
      // A sampled path steps over anything instantaneous; name those moments outright.
      const jumps: GltfSummary[] = [];
      for (const { node, path, track, ch } of posers) {
        if (!chain.includes(node)) continue;
        for (const j of findJumps(track)) {
          if (j.at < from - TIME_EPSILON || j.at > to + TIME_EPSILON) continue;
          jumps.push({
            at: round1(j.at),
            node: nodeLabel(node),
            path,
            to: shown(ch.path, j.to),
            effect: path === 'scale' ? visibilityChange(j.from, j.to) : undefined,
          });
        }
      }
      jumps.sort((a, b) => (a.at as number) - (b.at as number));
      pose = {
        animation: clipLabel(ci),
        node: nodeLabel(scopeRoot),
        window: round([from, to]),
        layout: opts.euler
          ? '[time, x, y, z, rx°, ry°, rz° (XYZ Euler), scale] in world space; scale is the ' +
            'largest world scale component — near 0 means hidden'
          : '[time, x, y, z, qx, qy, qz, qw, scale] in world space; scale is the largest ' +
            'world scale component — near 0 means hidden',
        movedBy: chain.filter((n) => animated.has(n)).map(nodeLabel),
        travel: box(lo, hi),
        jumps: jumps.length ? jumps.slice(0, JUMPS_SHOWN * 2) : undefined,
        path: rows.map(round),
      };
      if (!chain.some((n) => animated.has(n))) {
        notes.push(
          `${clipLabel(ci)} keys neither ${nodeLabel(scopeRoot)} nor any node above it; the path ` +
            'stands still.',
        );
      }
    }
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
  const scene = sceneIndex !== undefined ? json.scenes?.[sceneIndex] : undefined;
  const section = <T>(name: (typeof OMITTABLE)[number], value: T): T | undefined =>
    omit.has(name) ? undefined : value;
  return {
    format,
    bytes: bytes.length,
    version: json.asset?.version,
    generator: json.asset?.generator,
    copyright: json.asset?.copyright,
    extensionsUsed: json.extensionsUsed?.length ? json.extensionsUsed : undefined,
    extensionsRequired: json.extensionsRequired?.length ? json.extensionsRequired : undefined,
    extras: json.asset?.extras,
    units: 'glTF convention, not measured: metres, +Y up, front faces +Z',
    measured: hasSceneBounds ? measureHints(sceneMin, sceneMax) : undefined,
    rotations: opts.euler ? 'XYZ Euler degrees (three.js default order)' : undefined,
    scope: scoped ? { node: nodeLabel(scopeRoot), depth: opts.depth } : undefined,
    scene:
      scene?.name || scene?.extras !== undefined
        ? { name: scene.name, extras: scene.extras }
        : undefined,
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
    nodes: section('nodes', nodeEntries),
    meshes: section('meshes', meshEntries),
    materials: materialEntries.length ? section('materials', materialEntries) : undefined,
    images: imageEntries.length ? imageEntries : undefined,
    animations: animationEntries.length ? animationEntries : undefined,
    keyframes,
    pose,
    skins: skinEntries.length ? section('skins', skinEntries) : undefined,
    cameras: cameraEntries.length ? section('cameras', cameraEntries) : undefined,
    lights: lights.length ? section('lights', lights) : undefined,
    omitted: omit.size ? [...omit] : undefined,
    notes: notes.length ? notes : undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseOmit(raw: string[] | string | undefined): Set<string> {
  const names = (typeof raw === 'string' ? raw.split(',') : (raw ?? []))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !(OMITTABLE as readonly string[]).includes(n));
  if (unknown.length) {
    throw new GltfError(
      `omit names no section "${unknown.join('", "')}"; it takes: ${OMITTABLE.join(', ')}.`,
    );
  }
  return new Set(names);
}

/** `[from, to]`, or `"0.2-0.8"` / `"0.2..0.8"` with either end open. */
function parseRange(raw: [number, number] | string | undefined): [number, number] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 2 && raw.every(Number.isFinite)) return [raw[0], raw[1]];
  } else {
    const m = /^\s*(\d*\.?\d*)\s*(?:-|\.\.)\s*(\d*\.?\d*)\s*$/.exec(raw);
    if (m && (m[1] || m[2])) {
      return [m[1] ? Number(m[1]) : -Infinity, m[2] ? Number(m[2]) : Infinity];
    }
  }
  throw new GltfError(
    `range must be [from, to] or "from-to" in seconds, not ${JSON.stringify(raw)}.`,
  );
}

/**
 * What the bounds say that the glTF convention does not: a size that reads as centimetres,
 * and which way a long object points. Facts about the box, worded as likelihoods — a box
 * cannot prove where the front is.
 */
function measureHints(min: Vec3, max: Vec3): string[] | undefined {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const hints: string[] = [];
  const largest = Math.max(...size);
  if (largest >= 20) {
    hints.push(
      `The largest dimension is ${round1(largest)} units. Read as metres that is ` +
        `${round1(largest)} m; if the object is hand- or person-sized, the file is likely in ` +
        `centimetres (scale by 0.01 → ${round1(largest / 100)} m).`,
    );
  }
  // The longer horizontal axis, and which side of the origin it reaches farther toward.
  const [axis, other] = size[2] >= size[0] ? [2, 0] : [0, 2];
  const name = axis === 2 ? 'Z' : 'X';
  if (size[axis] > 0 && size[axis] >= 1.5 * size[other]) {
    const plus = Math.max(0, max[axis]);
    const minus = Math.max(0, -min[axis]);
    const far = plus >= minus ? '+' : '−';
    const ratio = Math.max(plus, minus) / Math.max(1e-9, Math.min(plus, minus));
    const reach = `reaches ${round1(minus)} toward −${name} and ${round1(plus)} toward +${name} from the origin`;
    if (ratio >= 1.5) {
      const verdict =
        name === 'Z' && far === '+'
          ? 'likely +Z, as the convention says'
          : `likely ${far}${name}, not the +Z the convention says`;
      hints.push(
        `Longest horizontally along ${name}; it ${reach}. For an object that points (a weapon, ` +
          `a tool, a vehicle) held or pivoted at its origin, the front is ${verdict}.`,
      );
    } else {
      hints.push(`Longest horizontally along ${name}; it ${reach}.`);
    }
  }
  return hints.length ? hints : undefined;
}

/** A key interval to the microsecond: 0.5001f − 0.5f is 0.000100017, and reads as 0.0001. */
function roundDt(dt: number): number {
  return Number(dt.toFixed(6));
}

/** What a near-instant scale jump does: to or from (near) zero is a hide or a show. */
function visibilityChange(from: number[], to: number[]): string | undefined {
  const size = (v: number[]) => Math.max(...v.map(Math.abs));
  const [a, b] = [size(from), size(to)];
  if (a >= 0.01 && b < 0.01) return 'hides';
  if (a < 0.01 && b >= 0.01) return 'shows';
  return undefined;
}

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
