/**
 * JSON laid out for a reader who greps: one line per small record, arrays of numbers kept on
 * the line they belong to. `JSON.stringify(v, null, 2)` gives a vec3 three lines and a node
 * fifteen, so a line filter on a node's name returns its name and nothing about it.
 */

const MAX_INLINE = 160;

export function formatSummaryJson(value: unknown): string {
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
