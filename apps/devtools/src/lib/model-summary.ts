/**
 * A model summary as `inspectModel` hands it back.
 *
 * The server's reader answers in grep-friendly JSON — one small record per line, number
 * arrays on the line they belong to — but the app door parses it on the way in, so printing
 * it again with `JSON.stringify(v, null, 2)` gave a vec3 three lines and a node fifteen. This
 * re-lays it out the way the server wrote it (`@yaar/lib/gltf`'s `formatSummaryJson`).
 *
 * The summary's `readOptions` hint names the storage read's `gltf*` options; an agent calling
 * `inspectModel` passes different names, so the hint is replaced with this command's own.
 */

const MAX_INLINE = 160;

export const INSPECT_MODEL_OPTIONS: Record<string, string> = {
  node: 'a node name or "#index": scope to its subtree, with per-channel keyframe stats',
  keys: 'an animation name: its keyframes as [time, ...value] rows (with node, that subtree only)',
  pose: "an animation to play: with at, every node in world space and posed bounds at that time; without, node's world path over the clip",
  at: 'seconds into the pose clip for the snapshot',
  range: '"from-to" seconds: window keys rows and a pose path',
  step: 'seconds: resample keys (and a pose path) instead of raw keys',
  euler: 'true: rotations as XYZ Euler degrees',
  omit: 'comma list of sections to leave out, e.g. "meshes,materials,images"',
  depth: 'how many levels of the node tree to list',
};

export function formatModelSummary(result: unknown): string {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value as string;
    }
  }
  if (value && typeof value === 'object' && 'readOptions' in value) {
    value = { ...(value as Record<string, unknown>), readOptions: INSPECT_MODEL_OPTIONS };
  }
  return fmt(value, '');
}

function fmt(value: unknown, pad: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const inline = JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object') || inline.length <= MAX_INLINE) {
      return inline;
    }
    const inner = pad + '  ';
    return `[\n${value.map((v) => inner + fmt(v, inner)).join(',\n')}\n${pad}]`;
  }
  if (inline.length <= MAX_INLINE) return inline;
  const inner = pad + '  ';
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${fmt(v, inner)}`).join(',\n')}\n${pad}}`;
}
