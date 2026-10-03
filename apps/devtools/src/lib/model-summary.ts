/**
 * A model summary as `inspectModel` hands it back.
 *
 * The server's reader answers in grep-friendly JSON — one small record per line, number
 * arrays on the line they belong to — but the app door parses it on the way in, so printing
 * it again with `JSON.stringify(v, null, 2)` gave a vec3 three lines and a node fifteen. This
 * re-lays it out the way the server wrote it (`@yaar/lib/gltf`'s `formatSummaryJson`).
 *
 * The summary's `readOptions` hint names the storage read's `gltf` bag; `inspectModel` takes
 * the same options flat, so the hint is unwrapped to the bag's contents.
 */

const MAX_INLINE = 160;

export function formatModelSummary(result: unknown): string {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value as string;
    }
  }
  const hint = (value as { readOptions?: { gltf?: unknown } } | null)?.readOptions;
  if (hint && typeof hint === 'object' && 'gltf' in hint) {
    value = { ...(value as Record<string, unknown>), readOptions: hint.gltf };
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
