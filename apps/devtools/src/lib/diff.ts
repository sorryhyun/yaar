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
