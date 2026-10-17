/**
 * Repairs for a model that mismanages JSON escape depth in tool arguments.
 *
 * Two opposite failures, both observed on the parsed tool input (the stream-side
 * detector for the third lives in `escape-tripwire.ts`):
 *
 *  - **Over-escaping.** `"안녕"` is written as `"\\uc548\\ub155"`, which parses to
 *    the *literal text* `\uc548\ub155` rather than to characters. This is the one
 *    that lands visibly corrupted in files.
 *  - **Under-escaping.** A parameter whose value is itself JSON text is written
 *    with `\n` where `\\n` was meant. The outer parse consumes the escape, so the
 *    inner payload carries a raw U+000A inside a string literal — illegal per
 *    RFC 8259 — and whoever parses it next throws. In the CLI panel the same
 *    event shows up as a line break where `\n` was meant, because
 *    `CliPanel.module.css` renders entries `white-space: pre-wrap`.
 *
 * Both repairs are deliberately conservative: each rewrites only when it can
 * prove the rewrite is the fix. Over-escaping decodes a run only when the result
 * is non-ASCII (so `\u0041` in genuine source survives); under-escaping rewrites
 * only when the candidate fails `JSON.parse` before and succeeds after. A repair
 * that cannot demonstrate it helped leaves the value untouched.
 *
 * @see providers/claude/escape-tripwire.ts — the mid-stream detector, which
 * catches over-escaping before the arguments finish generating.
 */

/**
 * A run of one or more `\uXXXX` escapes, as literal text in an already-parsed
 * string, whose leading backslash is not itself escaped.
 *
 * Group 1 is the even run of backslashes before it (zero included), which stays
 * as written: `\\uc548` is an escaped backslash followed by the text `uc548`,
 * not an escape, and decoding it would change what the text means — in source
 * it becomes `\안`, and inside a nested JSON payload an invalid escape. The
 * lookbehind pins the pairs to the start of the backslash run, so the scan
 * cannot begin halfway through one.
 */
const LITERAL_ESCAPE_RUN = /(?<!\\)((?:\\\\)*)((?:\\u[0-9A-Fa-f]{4})+)/g;

/** JSON's own short escapes for the control characters that have one. */
const SHORT_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/**
 * Decode literal `\uXXXX` runs that were meant to be characters.
 *
 * Scoped by result, not by tool: a run is decoded only when it yields at least
 * one non-ASCII character. An agent writing `"\u0041"` into a source file means
 * those six characters, and rewriting them would be the corruption rather than
 * the fix. Surrogate pairs survive because the halves are emitted adjacently
 * into the same output string, which is UTF-16.
 */
export function decodeOverEscaped(text: string): string {
  return text.replace(LITERAL_ESCAPE_RUN, (whole, pairs: string, run: string) => {
    const decoded = run.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    const hasNonAscii = [...decoded].some((c) => (c.codePointAt(0) ?? 0) > 0x7f);
    return hasNonAscii ? pairs + decoded : whole;
  });
}

/**
 * Extensions whose files carry `\uXXXX` as meaningful syntax.
 *
 * In a source file or JSON document a single-backslash escape is a legitimate
 * way to write a character (`'\uc548'` in a string literal, a `\u` escape in
 * JSON), and the parsed tool input cannot tell that apart from over-escaping —
 * both arrive as the same six characters. Decoding would rewrite text the agent
 * meant, so for these targets the escapes are left as written.
 */
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs|jsx|json)$/i;

/** Whether a call target (a path or `yaar://` URI) names a source file. */
export function isSourceFile(target: string): boolean {
  return SOURCE_FILE.test(target.replace(/[?#].*$/, ''));
}

/**
 * Re-escape raw control characters that sit inside a JSON string literal.
 *
 * Walks the text tracking string/escape state rather than using a regex: a raw
 * newline *between* tokens is legal JSON whitespace and must be left alone, so
 * the two cases can only be told apart positionally.
 */
function escapeRawControls(src: string): string {
  let out = '';
  let inString = false;
  let afterBackslash = false;

  for (const ch of src) {
    if (afterBackslash) {
      out += ch;
      afterBackslash = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      afterBackslash = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch < ' ') {
      out += SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Repair a nested-JSON string whose escapes were eaten by the outer parse.
 *
 * Returns the repaired text, or `null` when the value is not nested JSON, is
 * already valid, or does not become valid under the repair. That last case is
 * the important one: a string that fails to parse for some *other* reason is
 * left exactly as the model wrote it, so this can never turn one broken payload
 * into a differently broken payload.
 */
export function repairNestedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    JSON.parse(trimmed);
    return null; // already valid — nothing to repair
  } catch {
    // candidate
  }
  const repaired = escapeRawControls(text);
  if (repaired === text) return null;
  try {
    JSON.parse(repaired.trim());
    return repaired;
  } catch {
    return null; // broken for some other reason; not ours to touch
  }
}

/** What a repair pass changed, for logging and for the model's own feedback. */
export interface RepairReport {
  value: unknown;
  /** Dotted paths whose literal `\uXXXX` runs were decoded. */
  overEscaped: string[];
  /** Dotted paths whose nested JSON had raw control characters re-escaped. */
  underEscaped: string[];
}

/**
 * Apply both repairs across a tool-input object, recording what changed.
 *
 * Order matters: over-escaping is decoded first, since a doubly-escaped nested
 * payload has to become text before it can be recognized as JSON at all.
 *
 * `decodeEscapes: false` skips that decode (see `isSourceFile`); the nested-JSON
 * repair still runs, since it only rewrites a value it can prove was broken.
 */
export function repairToolInput(
  input: unknown,
  { decodeEscapes = true }: { decodeEscapes?: boolean } = {},
): RepairReport {
  const overEscaped: string[] = [];
  const underEscaped: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      let next = decodeEscapes ? decodeOverEscaped(value) : value;
      if (next !== value) overEscaped.push(path || '<root>');
      const nested = repairNestedJson(next);
      if (nested !== null) {
        underEscaped.push(path || '<root>');
        next = nested;
      }
      return next;
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, path ? `${path}.${k}` : k),
        ]),
      );
    }
    return value;
  };

  return { value: walk(input, ''), overEscaped, underEscaped };
}
