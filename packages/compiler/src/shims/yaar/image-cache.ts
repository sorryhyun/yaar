// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Paging through images that arrive as bytes rather than as URLs an `<img>` can load.
 *
 * An app whose images need a Referer, a proxy, or a local file ends up holding blob
 * URLs, and a reader or lightbox over them needs the same three things every time:
 * keep the last few alive and revoke the rest (each is megabytes), remember which
 * ones are ready so a page already fetched shows without a spinner frame, and fetch
 * and decode the neighbours so stepping to them never flashes an empty stage. crawl
 * wrote that twice (its lightbox and its hitomi reader) and dc-comics was about to
 * write it a third time; this is those lines, once.
 *
 * Nothing runs at module scope: `protocol/fold-schemas.ts` evaluates an app's entry
 * module in a Worker with a stubbed `document`.
 */

export interface BlobUrlCacheOptions<K> {
  /**
   * How many blob URLs stay alive. Past it the least recently used is revoked.
   * An `<img>` already showing a revoked URL keeps painting (the element holds the
   * decoded image); only handing that URL to a *new* element breaks.
   */
  max: number;
  /** The bytes for a key. A rejection is not cached: the next `get` tries again. */
  load: (key: K) => Promise<Blob>;
  /** The cache key for a non-string `K`. Defaults to `String(key)`. */
  keyOf?: (key: K) => string;
}

export interface BlobUrlCache<K> {
  /** The blob URL for `key`, loading it on first ask. Marks it most recently used. */
  get(key: K): Promise<string>;
  /** The URL if it has already loaded, else `undefined`. Starts nothing. */
  peek(key: K): string | undefined;
  /** Load and decode `key` in the background, swallowing failure — for neighbours. */
  preload(key: K): void;
  /** Revoke every URL and forget everything, including loads still in flight. */
  clear(): void;
}

export function createBlobUrlCache<K = string>(options: BlobUrlCacheOptions<K>): BlobUrlCache<K> {
  const keyOf = options.keyOf ?? ((key: K) => String(key));
  const pending = new Map<string, Promise<string>>();
  const ready = new Map<string, string>();

  const drop = (id: string, url: Promise<string>) => {
    pending.delete(id);
    ready.delete(id);
    url.then(URL.revokeObjectURL, () => {});
  };

  const get = (key: K): Promise<string> => {
    const id = keyOf(key);
    let url = pending.get(id);
    if (url) {
      pending.delete(id);
    } else {
      const loading = options.load(key).then((blob) => {
        const made = URL.createObjectURL(blob);
        // Evicted while loading: `drop` has already chained the revoke onto this promise.
        if (pending.get(id) === loading) ready.set(id, made);
        return made;
      });
      loading.catch(() => {
        if (pending.get(id) === loading) pending.delete(id);
      });
      url = loading;
    }
    pending.set(id, url);
    for (const [oldId, old] of pending) {
      if (pending.size <= options.max) break;
      drop(oldId, old);
    }
    return url;
  };

  return {
    get,
    peek: (key) => ready.get(keyOf(key)),
    preload: (key) => {
      get(key).then(decodeImage, () => {});
    },
    clear: () => {
      for (const [id, url] of [...pending]) drop(id, url);
    },
  };
}

// Held here so an <img> given the same URL paints at once instead of going blank
// while it decodes. Bounded: an entry whose blob URL was revoked is inert.
const KEEP_DECODED = 10;
const decoded = new Map<string, { img: HTMLImageElement; ready: Promise<void> }>();

/**
 * Decode `url` off-screen and hold the result, so an `<img>` given it next paints on
 * the first frame. Swap an image's `src` only after this resolves and stepping never
 * flashes an empty stage. A failed decode still resolves: the swap goes ahead and
 * the `<img>` shows its own broken state.
 */
export function decodeImage(url: string): Promise<void> {
  let entry = decoded.get(url);
  if (entry) {
    decoded.delete(url);
  } else {
    const img = new Image();
    img.src = url;
    entry = { img, ready: img.decode().catch(() => {}) };
  }
  decoded.set(url, entry);
  for (const old of decoded.keys()) {
    if (decoded.size <= KEEP_DECODED) break;
    decoded.delete(old);
  }
  return entry.ready;
}
