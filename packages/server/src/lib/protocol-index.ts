/**
 * The **index** form of a protocol — one line per command, enough to call from.
 *
 * A protocol has two honest sizes and they are an order of magnitude apart. The full
 * manifest is every schema and every word an app author wrote (studio-3d: 41.8 KB, of
 * which 24.8 KB is command prose); the index is a signature and an opening sentence per
 * command (~8 KB for the same 52 commands). Both are wanted, by different callers at
 * different moments — "which command do I want" is not "what exactly does this one do" —
 * and the mistake was making one door answer both questions with the larger shape.
 *
 * So the index is not a *degraded* manifest that a byte budget switches on. It is what
 * `list` means, at both doors that list commands:
 *
 *   list('yaar://apps/{id}/protocol')  — the installed app's commands
 *   list('yaar://windows/{id}')        — a running window's, live off the iframe
 *
 * The full text is always one hop away (`read('yaar://apps/{id}/protocol/commands/{k}')`
 * or `describe('yaar://windows/{id}/commands/{k}')`), and a truncated summary says so by
 * ending in an ellipsis rather than by pretending to be the whole description.
 *
 * Lives in `lib/` for the same reason `command-signature.ts` does: it reads a JSON Schema
 * fragment and some prose and returns a string.
 */

import { renderSignature, type SchemaDefs } from './command-signature.js';

/**
 * How much of a description an index row may carry.
 *
 * Sized against the shape the rule rewards: a front-loaded summary sentence. 220 chars is
 * a generous one — of studio-3d's 52 commands the median opening sentence is well under
 * it — so an author who writes the way the guides ask gets their sentence verbatim and
 * never sees the ellipsis.
 */
export const INDEX_SUMMARY_MAX = 220;

/**
 * A period that belongs to an abbreviation rather than to a sentence.
 *
 * The naive rule (cut at the first `.` followed by whitespace) truncates "Applies a
 * boolean operation, e.g. union or subtract" to five words, and `e.g.`/`i.e.` open a
 * clause often enough to matter. The discriminator is the token the period is attached
 * to, not the length of the sentence so far — a short opening sentence ("Move a node to a
 * point.") is perfectly ordinary and a length floor throws it away.
 *
 * An abbreviation's last token is one or two letters (`e.g`, `i.e`, `Dr`, `vs`, `U.S`) or
 * already contains a period. A word ending a real sentence is longer than that. The false
 * positive this accepts — a sentence genuinely ending in a two-letter word — costs one
 * extra clause in a summary, which is the cheap direction to be wrong in.
 */
const ABBREVIATION_TAIL = /(?:^|\s)([A-Za-z]{1,2}|[A-Za-z.]*\.[A-Za-z]{1,2})$/;

/**
 * The first sentence of a description, capped.
 *
 * Three cuts, in order: the first blank line (a multi-paragraph description's opening
 * paragraph is already the summary), the first sentence-ending punctuation followed by
 * whitespace, and the hard cap. Only the last one appends an ellipsis — a description
 * that *is* one short sentence is reproduced exactly, with no marker suggesting
 * something was withheld.
 */
export function firstSentence(text: unknown, max = INDEX_SUMMARY_MAX): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  // A paragraph break ends the summary regardless of punctuation.
  const paragraph = trimmed.split(/\n\s*\n/)[0].trim();

  let sentence = paragraph;
  const punctuation = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = punctuation.exec(paragraph)) !== null) {
    // `!` and `?` never end an abbreviation; only a period needs the check.
    if (match[0] === '.' && ABBREVIATION_TAIL.test(paragraph.slice(0, match.index))) continue;
    sentence = paragraph.slice(0, match.index + 1);
    break;
  }

  // Newlines inside one paragraph are wrapping, not structure — a row is one line.
  sentence = sentence.replace(/\s+/g, ' ').trim();
  if (sentence.length <= max) return sentence;

  // Cut on a word boundary so the ellipsis never lands mid-identifier.
  const cut = sentence.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The `description` of a protocol entry, whether it is a bare string or a descriptor. */
export function descriptionOf(descriptor: unknown): string {
  if (typeof descriptor === 'string') return descriptor;
  const described = (descriptor as { description?: unknown } | null | undefined)?.description;
  return typeof described === 'string' ? described : '';
}

/**
 * One command as an index row: `moveNode(id: string, to: vec3) — Move a node.`
 *
 * `renderSignature` returns the bare name for a command that declares no schema, and in
 * that case the em dash would separate a name from its own description for no reason, so
 * the row collapses to `name — summary`. Nothing is invented for a command that
 * documents nothing: an undocumented command's row is just its signature.
 */
export function commandRow(name: string, descriptor: unknown, defs?: SchemaDefs): string {
  const signature = renderSignature(name, descriptor, defs);
  const summary = firstSentence(descriptionOf(descriptor));
  return summary ? `${signature} — ${summary}` : signature;
}

/**
 * The same row, for a `resource_link` whose `name` field already states the command.
 *
 * The difference is one case: a command that declares no schema renders as its bare name,
 * and prefixing `openPath — ` to a link already named `commands/openPath` spends bytes to
 * say the name a third time. A real signature is never redundant — it carries the params —
 * so it stays.
 */
export function commandLinkDescription(
  name: string,
  descriptor: unknown,
  defs?: SchemaDefs,
): string {
  const signature = renderSignature(name, descriptor, defs);
  const summary = firstSentence(descriptionOf(descriptor));
  if (signature === name) return summary;
  return summary ? `${signature} — ${summary}` : signature;
}

/** One state key as an index row: `selection — The ids currently selected.` */
export function stateRow(key: string, descriptor: unknown): string {
  const summary = firstSentence(descriptionOf(descriptor));
  return summary ? `${key} — ${summary}` : key;
}

/** The manifest shape these readers need — every field optional, none assumed. */
interface IndexableProtocol {
  state?: Record<string, unknown>;
  commands?: Record<string, unknown>;
}

/**
 * The whole protocol as index rows, plus the counts a caller needs to decide whether the
 * full manifest is worth a second call.
 */
export function buildProtocolIndex(
  protocol: IndexableProtocol | undefined,
  defs?: SchemaDefs,
): { state: string[]; commands: string[] } {
  return {
    state: Object.entries(protocol?.state ?? {}).map(([key, d]) => stateRow(key, d)),
    commands: Object.entries(protocol?.commands ?? {}).map(([key, d]) => commandRow(key, d, defs)),
  };
}
