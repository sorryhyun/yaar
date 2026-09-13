/**
 * Range-parallel file downloader, resumable at chunk granularity.
 *
 * A single HTTPS stream to the Hugging Face CDN tops out around 40 MB/s no matter
 * how fat the local link is; eight concurrent Range requests reach ~62 MB/s. Past
 * eight the edge throttles and throughput *regresses*, so DEFAULT_CONNECTIONS is a
 * measured optimum rather than a guess.
 *
 * Two CDN behaviours this has to work around:
 *  - The signed URL behind HF's 302 is minted for whatever Range was on the request
 *    that triggered the redirect. Resolve with no Range header, or every chunk but
 *    the first 403s with "Auth failed: invalid range".
 *  - `Response.url` reorders query parameters, which invalidates the signature. The
 *    `Location` header has to be carried verbatim.
 */

import { open, mkdir, rename, stat, unlink, readFile, writeFile } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { dirname } from 'path';
import { validateUrl } from '../ssrf.js';

const DEFAULT_CONNECTIONS = 8;
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_ATTEMPTS = 4;

export interface DownloadOptions {
  connections?: number;
  chunkBytes?: number;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Sidecar next to the `.part` file, so an interrupted transfer resumes per chunk. */
interface ResumeMeta {
  url: string;
  total: number;
  chunkBytes: number;
  /** Upstream validator — a changed weight file must invalidate the partial. */
  etag: string;
  done: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Follow redirects by hand so each hop is SSRF-validated and the final `Location`
 * survives unmodified. `fetch`'s own redirect follower hands back a normalised URL
 * that the CDN rejects.
 */
async function resolveFinalUrl(url: string, signal?: AbortSignal): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    validateUrl(current);
    const res = await fetch(current, { redirect: 'manual', signal });
    // An undrained body pins the socket open.
    await res.body?.cancel().catch(() => {});
    if (res.status < 300 || res.status >= 400) return current;
    const loc = res.headers.get('location');
    if (!loc) return current;
    // Absolute targets pass through untouched; only relative ones get resolved.
    current = /^https?:\/\//i.test(loc) ? loc : new URL(loc, current).href;
  }
  throw new Error('Too many redirects');
}

interface Probe {
  total: number;
  ranges: boolean;
  etag: string;
}

/** Ask for one byte: a 206 tells us both the full size and that Range works. */
async function probe(finalUrl: string, signal?: AbortSignal): Promise<Probe> {
  const res = await fetch(finalUrl, { headers: { Range: 'bytes=0-0' }, signal });
  const etag = res.headers.get('etag') ?? res.headers.get('last-modified') ?? '';
  const contentRange = res.headers.get('content-range');

  if (res.status === 206 && contentRange) {
    await res.arrayBuffer().catch(() => {});
    const total = Number(contentRange.split('/')[1]);
    if (Number.isFinite(total) && total > 0) return { total, ranges: true, etag };
    return { total: 0, ranges: false, etag };
  }

  // A 200 means Range was ignored and the whole file is inbound — don't read it.
  const status = res.status;
  const statusText = res.statusText;
  await res.body?.cancel().catch(() => {});
  if (status !== 200) throw new Error(`Upstream returned ${status} ${statusText}`);
  return { total: Number(res.headers.get('content-length') || 0), ranges: false, etag };
}

async function loadMeta(metaPath: string, want: Omit<ResumeMeta, 'done'>): Promise<Set<number>> {
  try {
    const prev = JSON.parse(await readFile(metaPath, 'utf8')) as ResumeMeta;
    const compatible =
      prev.url === want.url &&
      prev.total === want.total &&
      prev.chunkBytes === want.chunkBytes &&
      prev.etag === want.etag;
    if (compatible && Array.isArray(prev.done)) return new Set(prev.done);
  } catch {
    // No sidecar, or it is unreadable — start over.
  }
  return new Set();
}

/** Serialise sidecar writes; several workers finish chunks at once. */
function metaWriter(metaPath: string, base: Omit<ResumeMeta, 'done'>) {
  let chain: Promise<void> = Promise.resolve();
  return (done: Set<number>) => {
    chain = chain.then(async () => {
      const tmp = `${metaPath}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...base, done: [...done] } satisfies ResumeMeta));
      await rename(tmp, metaPath); // atomic: readers never see a torn sidecar
    });
    return chain.catch(() => {});
  };
}

/** Fallback for upstreams without Range support. */
async function downloadSingle(
  finalUrl: string,
  part: string,
  opts: DownloadOptions,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(finalUrl, { signal });
  if (!res.ok) throw new Error(`Upstream returned ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Upstream sent no body');

  const total = Number(res.headers.get('content-length') || 0);
  const fh = await open(part, 'w');
  try {
    const reader = res.body.getReader();
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value, 0, value.byteLength, loaded);
      loaded += value.byteLength;
      opts.onProgress?.(loaded, total || loaded);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Download `url` to `absDest`, using parallel Range requests when the upstream
 * supports them. Writes through `absDest.part` and renames on success, so readers
 * never observe a half-written file.
 */
export async function downloadToFile(
  url: string,
  absDest: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const connections = Math.max(1, opts.connections ?? DEFAULT_CONNECTIONS);
  const chunkBytes = Math.max(1, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const part = `${absDest}.part`;
  const metaPath = `${part}.json`;

  await mkdir(dirname(absDest), { recursive: true });

  // One failing chunk must tear down its siblings rather than leak sockets.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = ctl.signal;

  try {
    let finalUrl = await resolveFinalUrl(url, signal);
    const { total, ranges, etag } = await probe(finalUrl, signal);

    if (!ranges || total === 0 || connections === 1) {
      await downloadSingle(finalUrl, part, opts, signal);
      await rename(part, absDest);
      await unlink(metaPath).catch(() => {});
      return;
    }

    const base = { url, total, chunkBytes, etag };
    const chunkCount = Math.ceil(total / chunkBytes);
    const done = (await exists(part)) ? await loadMeta(metaPath, base) : new Set<number>();
    const saveMeta = metaWriter(metaPath, base);

    const chunkSize = (i: number) => Math.min((i + 1) * chunkBytes, total) - i * chunkBytes;
    let loaded = [...done].reduce((n, i) => n + chunkSize(i), 0);
    opts.onProgress?.(loaded, total);

    // Sparse-allocate up front: workers pwrite into disjoint windows.
    const fh: FileHandle = await open(part, done.size > 0 ? 'r+' : 'w');
    try {
      await fh.truncate(total);

      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const idx = next++;
          if (idx >= chunkCount) return;
          if (done.has(idx)) continue;
          await fetchChunk(idx);
        }
      };

      const fetchChunk = async (idx: number): Promise<void> => {
        const start = idx * chunkBytes;
        const end = Math.min(start + chunkBytes, total) - 1;

        for (let attempt = 1; ; attempt++) {
          let written = 0;
          try {
            const res = await fetch(finalUrl, {
              headers: { Range: `bytes=${start}-${end}` },
              signal,
            });
            if (res.status !== 206 || !res.body) {
              await res.body?.cancel().catch(() => {});
              throw new Error(`chunk ${idx}: expected 206, got ${res.status}`);
            }
            const reader = res.body.getReader();
            let pos = start;
            for (;;) {
              const { done: eof, value } = await reader.read();
              if (eof) break;
              await fh.write(value, 0, value.byteLength, pos);
              pos += value.byteLength;
              written += value.byteLength;
              loaded += value.byteLength;
              opts.onProgress?.(loaded, total);
            }
            if (written !== end - start + 1) throw new Error(`chunk ${idx}: short read`);

            done.add(idx);
            await saveMeta(done);
            return;
          } catch (err) {
            loaded -= written; // the retry re-counts these bytes
            if (signal.aborted || attempt >= MAX_ATTEMPTS) throw err;
            // A signed URL that expired (or was minted for another range) 403s —
            // mint a fresh one before retrying.
            finalUrl = await resolveFinalUrl(url, signal);
            await sleep(200 * attempt);
          }
        }
      };

      const workers = Array.from({ length: Math.min(connections, chunkCount) }, worker);
      try {
        await Promise.all(workers);
      } catch (err) {
        ctl.abort(); // stop the siblings still streaming
        throw err;
      }
    } finally {
      await fh.close().catch(() => {});
    }

    await rename(part, absDest);
    await unlink(metaPath).catch(() => {});
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
