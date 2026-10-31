export {};
import { errMsg, storage } from '@bundled/yaar';
import { files } from '../core';
import {
  diffStorageListings,
  findRealStoragePaths,
  isGeneratedPath,
  manifestString,
  storageDirsToWatch,
  type StorageChange,
  type StorageListing,
  type StorageReach,
} from '../lib';
import { readFileText } from './files';

// What a `preview/script` run did to the real shared tree. The server gives no record of a
// preview's writes, so the directories its literal paths name are listed before and after
// the run and compared. A write to a directory built at runtime goes unseen; `shared/{appId}`
// is always watched because that is where an app's own output goes.

/** A bound on one listing, so a huge directory cannot stall a run. */
const MAX_ENTRIES = 2000;
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Code that runs in a preview: fixtures under src/test/ name paths nothing writes. */
export const isAppSource = (path: string): boolean =>
  SOURCE.test(path) && !TEST_FILE.test(path) && !path.startsWith('src/test/');

async function walk(dir: string, out: StorageListing): Promise<void> {
  let entries: Awaited<ReturnType<typeof storage.list>>;
  try {
    entries = (await storage.list(dir)) ?? [];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= MAX_ENTRIES) return;
    const path = entry.path.replace(/\/$/, '');
    if (entry.isDirectory) await walk(path, out);
    else out.set(path, `${entry.size ?? 0}|${entry.modifiedAt ?? ''}`);
  }
}

async function snapshot(dirs: string[]): Promise<StorageListing> {
  const listing: StorageListing = new Map();
  for (const dir of dirs) await walk(dir, listing);
  return listing;
}

export interface StorageWatch {
  /** Literal real-storage paths in the script and the app's source, by file. */
  reach: StorageReach[];
  dirs: string[];
  report(): Promise<StorageChange[]>;
}

/** Start watching, before the run. A failed read costs the report, never the run. */
export async function watchRealStorage(scriptPath: string): Promise<StorageWatch | null> {
  try {
    const paths = files()
      .filter((f) => !f.isDirectory && !isGeneratedPath(f.path))
      .map((f) => f.path)
      .filter((p) => p === scriptPath || isAppSource(p));
    const sources = await Promise.all(
      paths.map(async (path) => ({ path, text: (await readFileText(path)) ?? '' })),
    );
    const reach = findRealStoragePaths(sources);
    const dirs = storageDirsToWatch(reach, manifestString(await readFileText('app.json'), 'appId'));
    const before = await snapshot(dirs);
    return {
      reach,
      dirs,
      report: async () => diffStorageListings(before, await snapshot(dirs)),
    };
  } catch (err) {
    console.error(`[devtools] watching real storage failed: ${errMsg(err)}`);
    return null;
  }
}

/** What a run owes its reader about real storage, or null when it touched none and names none. */
export function storageReport(
  watch: StorageWatch,
  changes: StorageChange[],
): { realStorageWrites?: StorageChange[]; storageWarning?: string } | null {
  const inScript = [...new Set(watch.reach.map((r) => r.path))];
  if (changes.length === 0 && inScript.length === 0) return null;
  const named = inScript.slice(0, 6).join(', ') + (inScript.length > 6 ? ', …' : '');
  return {
    ...(changes.length > 0 ? { realStorageWrites: changes } : {}),
    storageWarning:
      changes.length > 0
        ? `This run changed ${changes.length} real file(s) outside preview storage; a preview ` +
          'redirects only shared/self/ and yaar://apps/self/ paths. Clean them up if they were ' +
          'not meant to land.'
        : `No change seen in ${watch.dirs.join(', ')}, but the source names real storage ` +
          `(${named}): only shared/self/ and yaar://apps/self/ paths stay in preview storage.`,
  };
}
