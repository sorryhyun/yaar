// Where the bytes live: this machine's disk, under the app's own storage.
//
// `@bundled/yaar-ml`'s default route is `session(remoteUrl)` → `fetchWeights` →
// IndexedDB. That is the browser's cache, not the machine's: clearing site data drops
// it, quota pressure evicts it, and a different browser profile starts from zero. For
// 152 MB pulled from HuggingFace that is not a cache, it is a liability — the app would
// report "cached, usable offline" and then, one storage sweep later, need the network
// again to read a screenshot.
//
// So the same SDK's other door is used: `prefetchWeights` has the *server* stream each
// file to `storage/apps/ocr/models/…` over resumable Range requests, and hands back the
// same-origin `/api/storage/…` URL to read it from. `session()` and `fetchWeights()`
// take a local URL straight off disk and deliberately do not mirror it into IndexedDB,
// so there is exactly one copy and it is the durable one.
import { prefetchWeights } from '@bundled/yaar-ml';

export interface LoadProgress {
  ratio: number;
  loaded: number;
  total: number;
}

/** Anything that could become a path segment is stripped, not escaped. */
function safeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/**
 * Storage path for a model file, derived from the URL that names it.
 *
 * A HuggingFace `…/{owner}/{repo}/resolve/{rev}/{file}` becomes
 * `apps/self/models/{repo}/{file}` — so a model's weights and the `inference.yml`
 * holding its dictionary land in one directory named after the repo they came from,
 * and the layout on disk stays readable by a person wondering what those 152 MB are.
 * Deriving it beats a hand-written table: the pairing cannot drift from the URLs.
 */
export function destFor(url: string): string {
  let parts: string[] = [];
  try {
    parts = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    /* not parseable — fall through to the defaults below */
  }
  const repo = safeSegment(parts[1] ?? '', 'model');
  const file = safeSegment(parts[parts.length - 1] ?? '', 'weights.bin');
  return `apps/self/models/${repo}/${file}`;
}

/**
 * Make sure one remote file is on disk, and return the URL to read it back from.
 *
 * Already-downloaded files complete on the first poll, so this is the "is it here?"
 * step rather than an installer — every load path calls it, and only the first one
 * pays. `signal` stops the *polling*; the server-side transfer is detached and
 * resumable, so a cancelled download is picked up where it stopped rather than
 * restarted from zero.
 */
export async function ensureOnDisk(
  url: string,
  bytes: number | undefined,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const [localUrl] = await prefetchWeights([{ url, dest: destFor(url), bytes }], {
    signal,
    onProgress: (p) => {
      const total = p.total || bytes || 0;
      onProgress?.({ loaded: p.loaded, total, ratio: total ? p.loaded / total : 0 });
    },
  });
  return localUrl;
}
