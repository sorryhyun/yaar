export {};
import { scanJs } from './source-scan';

// A preview runs under its own principal, but only `self` spellings are redirected to its
// throwaway storage: `shared/self/…` lands in `shared/preview--{projectId}/`, while a literal
// `shared/music-maker/…` is the real commons, and every app holds that. Nothing on the
// server flags such a write, so this finds the literal paths and compares what is there.

export interface StorageReach {
  file: string;
  line: number;
  path: string;
}

const SHARED_LITERAL = /(?<![\w/.:$-])shared\/((?:\$\{[^}]*\}|[\w.-])+)([^\s"'`),\\]*)/g;
const STORAGE_URI = /yaar:\/\/storage\/([^\s"'`),\\]+)/g;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** A placeholder, a wholly runtime-built path, or an app's tree, which is not the commons. */
const NOT_A_PATH = /^(?:\.\.\.|\$\{|apps(?:\/|$))|…/;

/** The spelling a preview's storage takes: not the real tree. */
const isRedirected = (path: string): boolean => /^shared\/self(?:\/|$)/.test(path);

/**
 * Literal paths into the real shared tree: `shared/{name}…` and `yaar://storage/…`, skipping
 * `shared/self/…`, a bare `yaar://storage/shared/` prefix and placeholders. Lexical: a path in
 * a description or an error message is reported too, and one built at runtime is not. TS/JS
 * is read with comments masked; anything else (a script's JSON) whole.
 */
export function findRealStoragePaths(sources: { path: string; text: string }[]): StorageReach[] {
  const out: StorageReach[] = [];
  for (const { path, text } of sources) {
    const body = /\.[cm]?[jt]sx?$/.test(path) ? scanJs(text).masked : text;
    const seen = new Set<string>();
    const add = (raw: string, index: number) => {
      const found = raw.replace(/[.,;:/]+$/, '');
      if (!found || found === 'shared' || NOT_A_PATH.test(found)) return;
      if (isRedirected(found) || seen.has(found)) return;
      seen.add(found);
      out.push({ file: path, line: lineOf(body, index), path: found });
    };
    for (const m of body.matchAll(SHARED_LITERAL)) add(m[0], m.index);
    for (const m of body.matchAll(STORAGE_URI)) add(m[1], m.index);
  }
  return out;
}

/**
 * The directories to compare around a run: `shared/{appId}` always, plus the top directory of
 * each literal path. A `${...}` segment is taken as the app's own id, the usual spelling of
 * one; a file sitting directly in `shared/` names no directory and is only warned about.
 */
export function storageDirsToWatch(reach: StorageReach[], appId: string | null): string[] {
  const dirs = new Set<string>(appId ? [`shared/${appId}`] : []);
  for (const { path } of reach) {
    const segments = path.split('/');
    if (segments[0] === 'shared') {
      if (segments.length < 2) continue;
      const name = segments[1];
      if (name.includes('${')) {
        if (appId) dirs.add(`shared/${appId}`);
      } else if (segments.length > 2 || !name.includes('.')) {
        dirs.add(`shared/${name}`);
      }
      continue;
    }
    if (!segments[0].includes('$')) dirs.add(segments[0]);
  }
  return [...dirs];
}

export type StorageListing = Map<string, string>;

export interface StorageChange {
  path: string;
  change: 'created' | 'modified' | 'deleted';
}

/** What moved between two listings of path → size and modification time. */
export function diffStorageListings(
  before: StorageListing,
  after: StorageListing,
): StorageChange[] {
  const out: StorageChange[] = [];
  for (const [path, stamp] of after) {
    const was = before.get(path);
    if (was === undefined) out.push({ path, change: 'created' });
    else if (was !== stamp) out.push({ path, change: 'modified' });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) out.push({ path, change: 'deleted' });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
