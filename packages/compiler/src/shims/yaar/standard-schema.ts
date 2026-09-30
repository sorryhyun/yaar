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

/** The message a library falls back to when it has none to give. */
const BARE_MESSAGE = /^invalid input\.?$/i;

/** One declared value as a caller would type it back — quoted when it is a string. */
function showValue(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * What an issue with no real message was actually about, from its structured fields.
 *
 * `@bundled/zod` is `zod/mini`, which ships no locale: every issue arrives reading
 * "Invalid input" unless the app itself called `z.config(z.locales.en())`. A rejected
 * enum then named its field and nothing else — mesh-edit's `newMesh({type: 'torus'})`
 * said `type: Invalid input`, and the allowed values were nowhere in the answer. The
 * issue carries them (`values`, `expected`, ...), so say them here, once, for every
 * app, rather than asking each one to load a locale. A message that already says more
 * than the bare fallback is left alone — a loaded locale or an app's own `error` wins.
 */
function issueMessage(issue) {
  const message = issue.message || '';
  if (message && !BARE_MESSAGE.test(message)) return message;
  const what = explainIssue(issue);
  return what ? (message ? message + ': ' : '') + what : message;
}

function explainIssue(issue) {
  switch (issue.code) {
    case 'invalid_value':
      if (!Array.isArray(issue.values) || !issue.values.length) return '';
      return issue.values.length === 1
        ? 'expected ' + showValue(issue.values[0])
        : 'expected one of ' + issue.values.map(showValue).join(' | ');
    case 'invalid_type':
      return issue.expected ? 'expected ' + issue.expected : '';
    case 'invalid_union': {
      // Each branch's own complaint, when every branch is a plain type miss —
      // `string | number` says it; a union of objects has nothing that short to say.
      const expected = (issue.errors || []).map((branch) =>
        branch && branch.length === 1 && branch[0].code === 'invalid_type'
          ? branch[0].expected
          : null,
      );
      return expected.length && expected.every(Boolean) ? 'expected ' + expected.join(' | ') : '';
    }
    case 'too_small':
      return issue.minimum !== undefined
        ? 'expected ' + sizeNoun(issue.origin) + (issue.inclusive ? '>= ' : '> ') + issue.minimum
        : '';
    case 'too_big':
      return issue.maximum !== undefined
        ? 'expected ' + sizeNoun(issue.origin) + (issue.inclusive ? '<= ' : '< ') + issue.maximum
        : '';
    case 'invalid_format':
      return issue.format ? 'expected ' + issue.format + ' format' : '';
    case 'unrecognized_keys':
      return Array.isArray(issue.keys) && issue.keys.length
        ? 'unrecognized key' + (issue.keys.length > 1 ? 's' : '') + ' ' + issue.keys.join(', ')
        : '';
    default:
      return '';
  }
}

/** `too_small`/`too_big` bound a length for these origins and the value itself otherwise. */
function sizeNoun(origin) {
  return origin === 'string' || origin === 'array' || origin === 'set' || origin === 'file'
    ? 'length '
    : '';
}

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
    return (path ? path + ': ' : '') + issueMessage(issue);
  });
  const extra = list.length - shown.length;
  return shown.join('; ') + (extra > 0 ? ' (and ' + extra + ' more)' : '');
}
