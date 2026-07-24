export {};

// The edit algebra: how a search/replace or line-range splice is applied to text.
// Pure — no signals, no storage, no active-project lookup — which is what makes it
// the most valuable thing in this codebase to have a unit test for. The behaviour
// below is subtle (see the function-replacer note in applyEdit) and currently
// cannot be exercised without booting the whole IDE.

/**
 * One edit step. Either `search`/`replace` (first match), or a 1-based inclusive
 * `startLine`/`endLine` range where `replace` omitted (or '') deletes the lines.
 * Line-range edits require `anchor`: the current text of `startLine`, compared
 * trimmed. Search mode anchors on content already; line numbers anchor on nothing,
 * so a stale one would splice into the wrong place silently.
 */
export interface EditSpec {
  search?: string;
  replace?: string;
  startLine?: number;
  endLine?: number;
  anchor?: string;
}

/** What one edit step produced: the new content, and the text it took out. */
interface EditResult {
  content: string;
  removed: string;
}

/**
 * Keep the head and tail of removed text, eliding the middle — a wrong splice is
 * usually visible at either edge, and both edges together beat twice as much head.
 */
export function truncateRemoved(text: string, max = 500): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${elided} chars elided] …\n${text.slice(-tail)}`;
}

function applyEdit(content: string, edit: EditSpec, label: string): EditResult {
  const hasSearch = edit.search !== undefined;
  const hasRange = edit.startLine !== undefined || edit.endLine !== undefined;
  if (hasSearch && hasRange) {
    throw new Error(`${label}: pass search/replace OR startLine/endLine, not both`);
  }
  if (hasSearch) {
    if (edit.replace === undefined) {
      throw new Error(
        `${label}: missing replacement text (pass replace or newString; '' deletes the match)`,
      );
    }
    if (!content.includes(edit.search!)) {
      throw new Error(`${label}: search string not found in file`);
    }
    // A function replacer inserts the replacement literally. Passing it as a string
    // would expand $&, $1, $` and $' — so a replacement containing `$` would
    // silently corrupt the file.
    return {
      content: content.replace(edit.search!, () => edit.replace!),
      removed: edit.search!,
    };
  }
  if (hasRange) {
    const lines = content.split('\n');
    const start = Math.trunc(Number(edit.startLine ?? edit.endLine));
    const end = Math.trunc(Number(edit.endLine ?? edit.startLine));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      throw new Error(
        `${label}: invalid line range ${edit.startLine}-${edit.endLine} ` +
          '(1-based, inclusive, startLine <= endLine)',
      );
    }
    if (start > lines.length) {
      throw new Error(
        `${label}: startLine ${start} is past the end of the file (${lines.length} lines)`,
      );
    }
    const actual = lines[start - 1] ?? '';
    if (edit.anchor === undefined) {
      throw new Error(
        `${label}: line-range edits require anchor (the current text of startLine). ` +
          `Line ${start} is: ${JSON.stringify(actual)}`,
      );
    }
    if (edit.anchor.trim() !== actual.trim()) {
      throw new Error(
        `${label}: anchor mismatch at line ${start} — expected ${JSON.stringify(edit.anchor)}, ` +
          `found ${JSON.stringify(actual)}. Nothing was written; re-read the file for current line numbers.`,
      );
    }
    // `replace` omitted or '' deletes the range; otherwise its lines take its place.
    const replacement = edit.replace ? edit.replace.split('\n') : [];
    const count = Math.min(end, lines.length) - start + 1;
    const removed = lines.splice(start - 1, count, ...replacement);
    return { content: lines.join('\n'), removed: removed.join('\n') };
  }
  throw new Error(
    `${label}: provide search/replace (aliases oldString/newString) or startLine/endLine + anchor`,
  );
}

/**
 * Apply edits sequentially against in-memory content. Throws on the first edit
 * that fails, naming its index — the caller writes nothing in that case, so a
 * multi-edit is all-or-nothing (an anchor mismatch anywhere aborts the batch).
 * Line numbers in later edits refer to the content AFTER earlier edits have been
 * applied. Returns the new content plus each edit's removed text, in order.
 */
export function applyEdits(
  content: string,
  edits: EditSpec[],
): { content: string; removals: string[] } {
  let current = content;
  const removals: string[] = [];
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `edit ${i + 1} of ${edits.length}` : 'edit';
    const result = applyEdit(current, edit, label);
    current = result.content;
    removals.push(result.removed);
  });
  return { content: current, removals };
}

/** One echo of what an edit took out, budget shared so a big batch stays bounded. */
export function formatRemoved(removals: string[]): string {
  if (removals.length === 1) return truncateRemoved(removals[0] ?? '');
  const budget = Math.max(120, Math.floor(500 / removals.length));
  return removals
    .map((text, i) => `── edit ${i + 1} ──\n${truncateRemoved(text, budget)}`)
    .join('\n');
}
