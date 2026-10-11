/**
 * Validation for a `renderer: "component"` window's layout, shared by `create` and `update`.
 *
 * Both paths used to cast the caller's `{ components, cols, gap }` straight into the action, so a
 * layout the DSL cannot express — `{ type: "markdown" }`, a `{ type: "row", components: [...] }`
 * container — was reported as created and painted as `unsupported: <type>` placeholders, the
 * agent learning nothing until the user complained (GitHub issue #173). The `.yaarcomponent.json`
 * path already ran the schema; this makes the inline paths run the same one, and turns Zod's
 * issues into an error that names the offending entry and what would have been accepted.
 */

import { COMPONENT_TYPES, type ComponentLayout } from '@yaar/shared';
import { componentLayoutSchema } from '@yaar/shared/schemas';

export type ComponentLayoutResult =
  | { ok: true; layout: ComponentLayout }
  | { ok: false; message: string };

/** Types an agent reaches for that the DSL deliberately lacks, with what to do instead. */
const ALTERNATIVES: Record<string, string> = {
  markdown: 'for rich text, open a separate `renderer: "markdown"` window',
  html: 'for rich content, open a separate `renderer: "html"` window',
  table: 'for tabular data, open a separate `renderer: "table"` window',
};

const CONTAINER_HINT =
  'Components are a flat array with no containers or nesting — use `cols` on the layout for side-by-side placement';

/** Parse `value` as a component layout, or explain what is wrong with it. */
export function parseComponentLayout(value: unknown): ComponentLayoutResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'Component content must be an object: { components: [...] }.' };
  }
  const { components } = value as Record<string, unknown>;
  if (components === undefined) {
    return { ok: false, message: '"content.components" is required for component renderer.' };
  }
  if (!Array.isArray(components)) {
    return { ok: false, message: '"content.components" must be an array of components.' };
  }

  // Unknown types first, all at once and in the DSL's own terms — Zod would report each as an
  // enum mismatch, and a container's nested `components` is silently stripped rather than flagged.
  const badTypes = components.flatMap((comp, i) => {
    const type = (comp as { type?: unknown } | null)?.type;
    return (COMPONENT_TYPES as readonly unknown[]).includes(type) ? [] : [{ i, type, comp }];
  });
  if (badTypes.length > 0) {
    const lines = badTypes.map(({ i, type, comp }) => {
      const shown = type === undefined ? 'no type' : `type ${JSON.stringify(type)}`;
      const hint =
        typeof type === 'string' && ALTERNATIVES[type]
          ? ` (${ALTERNATIVES[type]})`
          : comp && typeof comp === 'object' && 'components' in comp
            ? ' (containers are not supported)'
            : '';
      return `components[${i}]: ${shown}${hint}`;
    });
    return {
      ok: false,
      message:
        `Invalid component layout — unknown component type:\n${lines.join('\n')}\n` +
        `Valid types: ${COMPONENT_TYPES.join(', ')}. ${CONTAINER_HINT}. ` +
        `See yaar://skills/components.`,
    };
  }

  const result = componentLayoutSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path
        .map((seg, idx) =>
          typeof seg === 'number' ? `[${seg}]` : `${idx === 0 ? '' : '.'}${String(seg)}`,
        )
        .join('');
      return `${path || '(layout)'}: ${issue.message}`;
    });
    return {
      ok: false,
      message: `Invalid component layout:\n${lines.join('\n')}\nSee yaar://skills/components.`,
    };
  }
  return { ok: true, layout: result.data };
}
