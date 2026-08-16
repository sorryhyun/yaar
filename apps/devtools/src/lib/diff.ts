export {};
import { diffLines, createPatch } from '@bundled/diff';

// Pure diff arithmetic: turning two versions of a file into a unified patch and
// into the +/- counts shown beside a change. No signals, no storage — the panel
// supplies the text, this decides what the text amounts to.

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Line counts for a change, as a reader would tally them.
 *
 * `count` on a diff part is the number of lines in that part; the library only
 * omits it in edge cases, so the split is the fallback rather than the rule. A
 * pure move (identical text) is reported as 0/0 instead of the whole file — that
 * is what makes a no-op write distinguishable from a rewrite.
 */
export function diffStats(before: string, after: string): DiffStats {
  if (before === after) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split('\n').length;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

/**
 * Which lines of `after` differ from `before`, as merged 1-based inclusive ranges.
 *
 * Numbered in the **new** text, because that is the file a caller will read or edit
 * next — a range naming lines in a version that no longer exists is worse than no
 * range at all.
 *
 * A deletion occupies no line in the new text, so it is reported as the single line
 * it now sits in front of. That is what makes a *modification* — a removal and an
 * insertion at the same place — merge into one range instead of reading as two
 * separate edits.
 */
export function changedLineRanges(before: string, after: string): LineRange[] {
  if (before === after) return [];
  const total = after.split('\n').length;
  const raw: LineRange[] = [];
  let line = 1;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split('\n').length;
    if (part.added) {
      raw.push({ start: line, end: line + count - 1 });
      line += count;
    } else if (part.removed) {
      // Clamped: a deletion that runs to the end of the file leaves the cursor past
      // the last line, and a range pointing off the end names nothing.
      const at = Math.min(line, Math.max(1, total));
      raw.push({ start: at, end: at });
    } else {
      line += count;
    }
  }
  const merged: LineRange[] = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    // Adjacent ranges are joined too (`end + 1`): two hunks a line apart are one
    // region to a reader, and listing them separately only pads the result.
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Ranges as a reader would write them: `12, 40-44`.
 *
 * Capped, because a wholesale reformat produces one range per changed region and a
 * hundred of them says no more than the first few plus a count. The overflow is
 * stated rather than silently dropped.
 */
export function formatLineRanges(ranges: LineRange[], max = 12): string {
  const shown = ranges
    .slice(0, max)
    .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`));
  const rest = ranges.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
}

/** A unified patch for one file, with `context` unchanged lines around each hunk. */
export function buildPatch(name: string, before: string, after: string, context = 3): string {
  return createPatch(name, before, after, '', '', { context });
}

export interface TruncatedPatch {
  patch: string;
  /** True when lines were dropped — the panel offers "show more" only then. */
  truncated: boolean;
  /** Line count of the *full* patch, so the button can say how much is hidden. */
  totalLines: number;
}

/**
 * Cap a patch at `maxLines`.
 *
 * Cutting mid-hunk is deliberate and safe: diff2html parses whatever hunk lines
 * are present and renders a short hunk, so a truncated patch still draws. The
 * alternative — dropping whole hunks — loses the top of a large rewrite, which is
 * the part a reader looks at first.
 */
export function truncatePatch(patch: string, maxLines: number): TruncatedPatch {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) return { patch, truncated: false, totalLines: lines.length };
  return { patch: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines: lines.length };
}
