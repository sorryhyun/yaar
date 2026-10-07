export {};
import { state } from './state';
import { sortPrefs, type SortPrefs } from './layout';
import { basename, parseTime } from './helpers';
import type { StorageEntry } from './types';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function byName(a: StorageEntry, b: StorageEntry): number {
  return collator.compare(basename(a.path), basename(b.path));
}

/**
 * Directories always come first. Within a group the chosen key decides, with name as the
 * ascending tie-break so equal sizes or timestamps keep a stable, readable order. A
 * directory's size is not its contents' size, so size sorting orders directories by name.
 */
export function compareEntries(a: StorageEntry, b: StorageEntry, sort: SortPrefs): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const key = sort.key === 'size' && a.isDirectory ? 'name' : sort.key;
  let c: number;
  if (key === 'modified') c = (parseTime(a.modifiedAt) ?? 0) - (parseTime(b.modifiedAt) ?? 0);
  else if (key === 'size') c = (a.size ?? 0) - (b.size ?? 0);
  else c = byName(a, b);
  if (c === 0) return key === 'name' ? 0 : byName(a, b);
  if (key !== sort.key) return c;
  return sort.dir === 'desc' ? -c : c;
}

/** The current directory in display order — what the list renders and the protocol reports. */
export function sortedEntries(): StorageEntry[] {
  const sort = sortPrefs();
  return [...state.entries].sort((a, b) => compareEntries(a, b, sort));
}
