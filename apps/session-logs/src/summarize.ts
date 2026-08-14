/**
 * One-line summaries for transcript log rows.
 *
 * The transcript is read as a *log*: the question a collapsed row has to answer
 * is "what did this call do, to what" — verb + target — without expanding it.
 */

/** The five YAAR verb tools, where the verb is the name suffix and the target is `uri`. */
const VERB_TOOL = /^mcp__verbs__(read|list|invoke|describe|delete)$/;

/**
 * Parameter names that identify a call, best first. A tool outside the verb
 * family gets its most identifying param rather than a blob of JSON.
 */
const IDENTIFYING_KEYS = [
  'uri',
  'path',
  'file_path',
  'filePath',
  'file',
  'paths',
  'url',
  'command',
  'cmd',
  'pattern',
  'query',
  'q',
  'search',
  'expression',
  'stateKey',
  'appId',
  'name',
  'title',
  'id',
  'message',
  'prompt',
  'text',
];

/** `mcp__verbs__read` → `read`, `mcp__app__command` → `command`. */
export function shortToolName(name: string): string {
  const parts = name.split('__').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

/**
 * Drop the middle, keep both ends. A URI's head (scheme/app) and tail (the
 * actual resource) are both informative; it is the middle that is filler.
 */
export function middleTruncate(s: string, max = 72): string {
  if (s.length <= max) return s;
  const tail = Math.max(10, Math.floor((max - 1) * 0.62));
  const head = Math.max(4, max - 1 - tail);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * Split a target so the *tail* can be pinned and the head clipped.
 *
 * A fixed character budget cannot know the pane width, and CSS ellipsis always
 * eats the end — which on a URI is the only part worth reading. So the row
 * renders two spans: a head that shrinks (with its trailing ellipsis) and a
 * tail that never shrinks. Truncation then adapts to the real width and the
 * resource name always survives.
 */
export function splitTarget(s: string, maxTail = 20): { head: string; tail: string } {
  // Only for things whose tail is the payload — a URI or a path. Prose (a
  // reasoning preview, an error message) is informative at its *head*, so it
  // gets ordinary end-clipping instead.
  const pathLike = /^(\w[\w+.-]*:\/\/|[./~]|[\w.-]+\/)/.test(s);
  if (!pathLike || s.length <= 18) return { head: s, tail: '' };

  // Walk separators right-to-left, taking the longest tail that still fits.
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== '/' && s[i] !== '\\') continue;
    if (s.length - i > maxTail) break;
    cut = i;
  }
  // A final segment longer than the budget: cut mid-token rather than pin a
  // tail too wide to fit, which would overflow instead of eliding.
  if (cut < 0) cut = s.length - maxTail;
  if (cut <= 0) return { head: s, tail: '' };
  return { head: s.slice(0, cut), tail: s.slice(cut) };
}

/** First non-empty line, whitespace collapsed, clipped at the end. */
export function firstLine(s: string | undefined, max = 90): string {
  if (!s) return '';
  const line =
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render a param value compactly — never multi-line, never a wall of JSON. */
function renderValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(renderValue).filter(Boolean);
    return parts.length > 3
      ? `${parts.slice(0, 3).join(', ')}, +${parts.length - 3}`
      : parts.join(', ');
  }
  try {
    return JSON.stringify(v).replace(/\s+/g, ' ');
  } catch {
    return String(v);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The most identifying param of an arbitrary tool input. */
export function identifyingParam(input: unknown): string {
  const rec = asRecord(input);
  for (const key of IDENTIFYING_KEYS) {
    const val = rec[key];
    if (val != null && val !== '') {
      const rendered = renderValue(val);
      if (rendered) return rendered;
    }
  }
  // Nothing recognised: fall back to the first scalar, keyed so it reads.
  for (const [key, val] of Object.entries(rec)) {
    if (val == null || val === '') continue;
    const rendered = renderValue(val);
    if (rendered) return `${key}=${rendered}`;
  }
  return '';
}

export interface ToolSummary {
  /** Short verb for the chip: `read`, `invoke`, `grep`… */
  verb: string;
  /** The thing acted on — a URI, a path, a query. May be empty. */
  target: string;
}

/**
 * Verb + target for a tool call. The verb tools are parsed exactly (the verb is
 * the name suffix, the target is `input.uri`); anything else degrades to the
 * tool's short name plus its most identifying parameter.
 */
export function toolSummary(toolName: string | undefined, toolInput: unknown): ToolSummary {
  const name = (toolName ?? '').trim() || 'tool';
  const input = asRecord(toolInput);

  const verbMatch = name.match(VERB_TOOL);
  if (verbMatch) {
    const uri = typeof input.uri === 'string' ? input.uri : '';
    let target = uri;
    // `invoke` says almost nothing without its action — two URIs differ only there.
    if (verbMatch[1] === 'invoke') {
      const action = renderValue(input.action) || renderValue(asRecord(input.payload).action);
      if (action) target = uri ? `${uri} · ${action}` : action;
    }
    return { verb: verbMatch[1], target };
  }

  return { verb: shortToolName(name), target: identifyingParam(input) };
}

/** Does a tool result read like a failure? Drives the row's accent color. */
export function looksLikeError(content: string | undefined): boolean {
  if (!content) return false;
  return /\b(error|failed|failure|not permitted|denied|refused|exception|traceback|enoent)\b/i.test(
    content.slice(0, 200),
  );
}
