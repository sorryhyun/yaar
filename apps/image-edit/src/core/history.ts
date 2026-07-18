/**
 * Undo/redo over whole Doc values.
 *
 * Cheap because a Doc is a small plain object — the pixels are derived, never
 * stored. Loading a new image resets the stack rather than letting undo walk
 * back into a previous image's edits.
 */

import type { Doc } from './doc';

const LIMIT = 100;

/**
 * Docs are normally tiny, but a selection mask is one byte per source pixel —
 * ~12MB for a 12MP photo. Masks are shared by reference between history entries
 * that didn't change them, so this over-counts; it is a safety valve against a
 * session of many distinct selections, not an accounting system.
 */
const MASK_BYTE_BUDGET = 192 * 1024 * 1024;

function maskBytes(doc: Doc): number {
  return (doc.selection?.data.length ?? 0) + (doc.removed?.data.length ?? 0);
}

/** Drop the oldest entries until the retained masks fit the budget. */
function trim(past: Doc[]): Doc[] {
  let total = 0;
  for (const doc of past) total += maskBytes(doc);
  let start = 0;
  while (start < past.length - 1 && total > MASK_BYTE_BUDGET) {
    total -= maskBytes(past[start]);
    start++;
  }
  return start ? past.slice(start) : past;
}

export type History = {
  past: Doc[];
  future: Doc[];
};

export function createHistory(): History {
  return { past: [], future: [] };
}

/** Record `prev` as an undo step. Call BEFORE replacing the current doc. */
export function push(history: History, prev: Doc): History {
  const past = [...history.past, prev];
  if (past.length > LIMIT) past.shift();
  return { past: trim(past), future: [] };
}

export function undo(history: History, current: Doc): { history: History; doc: Doc } | null {
  if (!history.past.length) return null;
  const past = [...history.past];
  const doc = past.pop() as Doc;
  return { history: { past, future: [current, ...history.future] }, doc };
}

export function redo(history: History, current: Doc): { history: History; doc: Doc } | null {
  if (!history.future.length) return null;
  const [doc, ...future] = history.future;
  return { history: { past: [...history.past, current], future }, doc };
}
