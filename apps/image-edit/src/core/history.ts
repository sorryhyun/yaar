/**
 * Undo/redo over whole Doc values.
 *
 * Cheap because a Doc is a small plain object — the pixels are derived, never
 * stored. Loading a new image resets the stack rather than letting undo walk
 * back into a previous image's edits.
 */

import type { Doc } from './doc';

const LIMIT = 100;

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
  return { past, future: [] };
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
