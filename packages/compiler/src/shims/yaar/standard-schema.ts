// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The two things every Standard Schema consumer in the SDK needs: recognizing a
 * schema, and turning its issues into one line a human or an agent can act on.
 *
 * Two modules validate through the spec interface — `defineApp` on the way into
 * a command handler, `safeParseOr` on the way in from storage or the network —
 * and they must agree on both, or the same bad `{ text: 3 }` reads as two
 * different problems depending on which door it came through.
 *
 * Not exported from the barrel: this is an internal ownership boundary, not part
 * of the `@bundled/yaar` surface.
 */

/**
 * True for a Standard Schema — Zod v4, Valibot, ArkType and anything else that
 * implements the spec.
 *
 * The spec interface is what the SDK validates through, rather than Zod's own
 * `parse`: `@bundled/zod` maps to `zod/mini`, whose schemas deliberately carry no
 * methods (parsing there is `z.parse(schema, value)`), so a `.parse` check would
 * be false for the very library the docs point apps at.
 */
export function isStandardSchema(value) {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    !!value['~standard'] &&
    typeof value['~standard'].validate === 'function'
  );
}

/** How many issues a rejection names before it starts summarizing. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Render Standard Schema issues as `path: message` pairs joined with `; `,
 * summarizing the tail. Callers add their own prefix — the rejection's *subject*
 * (a command name, a storage label) is theirs to name, the issues are not.
 */
export function describeIssues(issues) {
  const list = issues || [];
  const shown = list.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = (issue.path || [])
      .map((seg) => (seg && typeof seg === 'object' ? seg.key : seg))
      .join('.');
    return (path ? path + ': ' : '') + issue.message;
  });
  const extra = list.length - shown.length;
  return shown.join('; ') + (extra > 0 ? ' (and ' + extra + ' more)' : '');
}
