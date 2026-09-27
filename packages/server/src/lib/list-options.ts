/**
 * The list verb's ordering and paging (`sort`, `order`, `range`) — the listing counterpart of
 * `read-options.ts`. A mounted folder can hold tens of thousands of entries; listed whole it
 * is a result past the spill threshold, and the model gets a 2 KB preview of an alphabetical
 * run it never asked for. Paging lets it walk the folder, and sorting lets the first page be
 * the one it wanted ("the newest files", "the largest").
 */

import { parseLineRange } from './read-options.js';

export type ListSort = 'name' | 'modified' | 'size';

export interface ListOptions {
  /** Order entries by name (directories first, the default), last write, or byte size. */
  sort?: ListSort;
  /** Defaults to "asc" for name and "desc" for modified/size — newest or largest first. */
  order?: 'asc' | 'desc';
  /** Entry range, e.g. "1-100", "101-200", "500-" (1-based, inclusive) — as `lines` on read. */
  range?: string;
  /**
   * How many entries a listing with no `range` returns. The MCP door sets it
   * ({@link LIST_PAGE_SIZE}); `POST /api/verb` leaves it unset, because an app's SDK call
   * wants the whole folder, not a page of it.
   */
  defaultLimit?: number;
}

/**
 * The page the MCP door returns when no `range` is given. A storage link block runs ~200
 * characters serialized, so this stays around 40 KB — well under the 100,000-character spill.
 */
export const LIST_PAGE_SIZE = 200;

/**
 * True when a list asked for an ordering or a page — `defaultLimit` is the door's, not the
 * caller's, so it is not a request that can be "ignored". A handler that honours these marks
 * the result `listFiltered`; one that does not gets a note from `ResourceRegistry.execute`.
 */
export function hasListOptions(options?: ListOptions): boolean {
  return Boolean(options?.sort || options?.order || options?.range);
}

interface Sortable {
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

function compareBy(sort: ListSort, a: Sortable, b: Sortable): number {
  switch (sort) {
    case 'modified':
      return Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt);
    case 'size':
      return a.size - b.size;
    case 'name':
      return a.path.localeCompare(b.path);
  }
}

/**
 * Sort and slice `entries`. Returns the page plus a note saying where it sits in the whole
 * and how to get the next one — null when the page is the entire, default-ordered listing.
 *
 * Directories group first for a name sort (the order a file browser shows) and last for a
 * size sort, where a directory's stat size is a block count, not its contents. A modified
 * sort mixes them: "what changed last" is a question about both.
 */
export function applyListOptions<T extends Sortable>(
  entries: T[],
  options: ListOptions = {},
): { page: T[]; note: string | null } | { error: string } {
  const sort = options.sort ?? 'name';
  const order = options.order ?? (sort === 'name' ? 'asc' : 'desc');
  const dir = order === 'asc' ? 1 : -1;
  const sorted = [...entries].sort((a, b) => {
    if (sort !== 'modified' && a.isDirectory !== b.isDirectory) {
      return (a.isDirectory ? -1 : 1) * (sort === 'name' ? 1 : -1);
    }
    return dir * compareBy(sort, a, b) || a.path.localeCompare(b.path);
  });

  const total = sorted.length;
  let start = 1;
  let end: number | null = options.defaultLimit ?? null;
  if (options.range) {
    const parsed = parseLineRange(options.range);
    if (!parsed) {
      return { error: `Invalid range: "${options.range}". Use "1-100", "101-200", or "500-".` };
    }
    [start, end] = parsed;
  }
  const last = Math.min(end ?? total, total);
  const page = sorted.slice(start - 1, last);

  const ordered = options.sort || options.order ? `, sorted by ${sort} ${order}` : '';
  if (options.range && start > total) {
    return { page, note: `Range starts past the end — this folder has ${total} entries.` };
  }
  if (!options.range && last >= total) {
    return { page, note: null };
  }
  const next =
    last < total
      ? ` Next page: range "${last + 1}-${Math.min(last + (last - start + 1), total)}".`
      : '';
  const hint =
    last < total && !options.sort
      ? ' Pass sort "modified" or "size" to see the newest or largest first.'
      : '';
  return { page, note: `Entries ${start}-${last} of ${total}${ordered}.${next}${hint}` };
}

/**
 * Read `sort`/`order`/`range` out of an untyped params bag — the app agent's
 * `command("storage:list", params)`, which has no schema of its own to validate against.
 */
export function parseListOptions(
  params: Record<string, unknown> | undefined,
): ListOptions | { error: string } {
  const { sort, order, range } = params ?? {};
  if (sort !== undefined && sort !== 'name' && sort !== 'modified' && sort !== 'size') {
    return { error: `Invalid sort: ${JSON.stringify(sort)}. Use "name", "modified" or "size".` };
  }
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    return { error: `Invalid order: ${JSON.stringify(order)}. Use "asc" or "desc".` };
  }
  if (range !== undefined && typeof range !== 'string') {
    return { error: 'Invalid range: pass a string like "1-100", "101-200" or "500-".' };
  }
  return { sort, order, range };
}
