/**
 * Frontend static file serving + SPA fallback.
 *
 * When running as a bundled executable, serves from Bun.embeddedFiles first.
 * Falls back to filesystem serving for dev mode or if no embedded assets found.
 *
 * Both branches answer conditional GETs (`ETag`, `Last-Modified`, `304`). Range
 * requests need no code here: Bun already turns a `Range` header on a `BunFile`
 * response into a `206` with `Content-Range`, and has since before 1.4.
 *
 * ## Why this is hand-rolled and not `Bun.serve`'s `{ dir }` route
 *
 * A `{ dir }` route serves exactly these headers, so it looks like the obvious
 * replacement for this file's filesystem branch. Measured on 1.4.0, it cannot be:
 *
 *   - **Its prefix has to be `/*` here.** The frontend build is flat — `main-<hash>.js`,
 *     the CSS, and the four webfonts all live at the URL root, and the font URLs are
 *     baked into `features/fonts`' catalog (`urlFaceCss`) and so into app-facing CSS.
 *     There is no `/assets/` prefix to mount under without moving that namespace.
 *   - **A route preempts `fetch` and never falls through.** A miss under `/*` is a
 *     `404`, not a hand-off, so mounting one would take the whole root namespace away
 *     from `createFetchHandler`: the SPA fallback, and — this is the one that matters —
 *     the `desktopRedirectTarget` check that keeps the desktop document off the app
 *     origin. `/api/*` and friends survive on route specificity; a document navigation
 *     to `/` would not.
 *   - **`DirectoryRouteOptions` has no header hook,** so responses would leave without
 *     the CORS headers `withCors` attaches, and it answers POST/OPTIONS with the file.
 *   - **It pins the directory by fd at `serve()` time.** `dev-bundler.ts` swaps a whole
 *     freshly built `dist/` into place with `rmSync` + `renameSync`, which leaves that
 *     fd pointing at the deleted inode: every asset `404`s from the first hot rebuild
 *     onward, with `statCache: false` no different. It also throws `ENOENT` at boot if
 *     `dist/` does not exist yet.
 *
 * None of that applies to the exe branch either, which reads from `Bun.embeddedFiles`
 * and could never have used a directory route. Adopting the behavior rather than the
 * mechanism gets both branches the same headers.
 */

import { existsSync } from 'fs';
import { join, extname } from 'path';
import { FRONTEND_DIST, IS_BUNDLED_EXE, MIME_TYPES } from '../../config.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('static');

// ── Caching + conditional GET ────────────────────────────────────────

/**
 * A build output whose name carries its own content hash (`main-a1b2c3d4.js`,
 * and the `.js.map` beside it), from `naming: '[dir]/[name]-[hash].[ext]'`.
 *
 * Those may be cached forever: a change to the bytes is a change to the URL. The
 * webfonts must not be — they are copied from `public/` under fixed names, and
 * they are also the 10.5 MB that makes revalidation worth having at all. Their
 * `-Rg`/`-Bd` suffixes are far under the hash-length floor, so they fall through
 * to `no-cache` and pay one conditional request each instead of a re-download.
 */
const HASHED_BUILD_OUTPUT = /-[A-Za-z0-9]{8,}\.(?:js|css)(?:\.map)?$/;

/**
 * Exported for tests, as `isStaticAsset` is in `auth.ts` and for the same reason: the
 * handler below resolves `FRONTEND_DIST` at module load, and `process.env` is shared by
 * every file in the `units` partition's one `--parallel` process — so a test that pointed
 * it at a fixture directory would be racing `features/fonts`, which reads the same
 * override. The predicates are the honest unit under test; the handler is two `if`s
 * around them.
 */
export function cacheControl(urlPath: string): string {
  return HASHED_BUILD_OUTPUT.test(urlPath) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/** What a client may send back to ask "still this one?". */
export interface Validators {
  etag: string;
  /** Omitted when the source has no honest mtime — see `embeddedValidators`. */
  lastModified?: Date;
}

/**
 * Filesystem validators: size and mtime, weak because they describe the file's
 * metadata rather than its bytes.
 *
 * `Bun.file()` reports both without a second `stat` — the branch has already
 * awaited `.exists()`, which populated them.
 */
export function fsValidators(file: Bun.BunFile): Validators | null {
  const { size, lastModified } = file;
  if (!Number.isFinite(size) || !Number.isFinite(lastModified) || lastModified <= 0) return null;
  return {
    etag: `W/"${size.toString(16)}-${Math.floor(lastModified).toString(16)}"`,
    lastModified: new Date(Math.floor(lastModified / 1000) * 1000),
  };
}

/**
 * Embedded validators: the `/$bunfs/root/main-6m6v52et.js` path Bun mints for an
 * embedded asset already ends in a hash **of the file's contents** — verified by
 * rebuilding a fixture with different bytes at the same length and watching the
 * suffix change. That makes it a strong validator, and a free one.
 *
 * No `Last-Modified`: an embedded file reports `lastModified` as 4503599627370495,
 * a sentinel that formats as a date in the year 144680. Sending it would be worse
 * than sending nothing.
 */
export function embeddedValidators(bunfsPath: string): Validators {
  return { etag: `"${bunfsPath.slice(bunfsPath.lastIndexOf('/') + 1)}"` };
}

/**
 * Does the request's `If-None-Match` name this entity? Handles `*` and weak-compares.
 *
 * Trim *before* looking for the `W/`, not after: in a list — `W/"a", W/"b"` — every entry
 * but the first arrives with the separator's space still on it, and a prefix test run
 * against that sees no `W/` and compares the weak form to the strong one.
 */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const strip = (t: string) => {
    const tag = t.trim();
    return tag.startsWith('W/') ? tag.slice(2) : tag;
  };
  const want = strip(etag);
  return header.split(',').some((candidate) => strip(candidate) === want);
}

/**
 * RFC 9110: `If-None-Match` wins outright when present, and `If-Modified-Since` is
 * only consulted in its absence. Both are compared at one-second resolution, since
 * that is all the `Last-Modified` we sent could carry.
 */
function isNotModified(req: Request, v: Validators): boolean {
  const inm = req.headers.get('if-none-match');
  if (inm) return etagMatches(inm, v.etag);

  const ims = req.headers.get('if-modified-since');
  if (ims && v.lastModified) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since)) return v.lastModified.getTime() <= since;
  }
  return false;
}

/**
 * The one place a static response is built, so a `304` cannot drift from the `200`
 * it stands in for: a conditional response has to repeat the validators, or the
 * next request arrives with nothing to revalidate against.
 */
export function staticResponse(
  req: Request,
  file: Bun.BunFile,
  urlPath: string,
  v: Validators | null,
): Response {
  const ext = extname(urlPath).toLowerCase();
  const headers: Record<string, string> = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl(urlPath),
  };
  if (v) {
    headers.ETag = v.etag;
    if (v.lastModified) headers['Last-Modified'] = v.lastModified.toUTCString();
    if (isNotModified(req, v)) return new Response(null, { status: 304, headers });
  }
  return new Response(file, { headers });
}

// ── Embedded asset serving (bundled exe) ─────────────────────────────

/**
 * Lazy-built map from URL path → embedded file path (/$bunfs/root/...).
 * Populated from __YAAR_EMBEDDED_FRONTEND which the build script sets on globalThis.
 */
let embeddedAssets: Map<string, string> | undefined;

function getEmbeddedAssets(): Map<string, string> {
  if (embeddedAssets) return embeddedAssets;
  embeddedAssets = new Map();

  const frontend = (globalThis as Record<string, unknown>).__YAAR_EMBEDDED_FRONTEND as
    | Record<string, string>
    | undefined;
  if (frontend) {
    for (const [urlPath, filePath] of Object.entries(frontend)) {
      embeddedAssets.set(urlPath, filePath);
    }
  }

  log.info('loaded embedded frontend assets', { assets: embeddedAssets.size });
  return embeddedAssets;
}

function serveEmbeddedAsset(req: Request, filePath: string, urlPath: string): Response {
  // Bun.file() reads from the embedded /$bunfs/ path
  return staticResponse(req, Bun.file(filePath), urlPath, embeddedValidators(filePath));
}

// ── Main handler ─────────────────────────────────────────────────────

export async function handleStaticRoutes(req: Request, url: URL): Promise<Response | null> {
  // Try embedded assets first when bundled
  if (IS_BUNDLED_EXE) {
    const assets = getEmbeddedAssets();
    if (assets.size > 0) {
      // Direct file match
      const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const embeddedPath = assets.get(reqPath);
      if (embeddedPath) {
        return serveEmbeddedAsset(req, embeddedPath, reqPath);
      }

      // SPA fallback: serve index.html for non-API/non-WS routes
      if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
        const indexPath = assets.get('/index.html');
        if (indexPath) {
          return serveEmbeddedAsset(req, indexPath, '/index.html');
        }
      }

      return null;
    }
  }

  // Filesystem fallback (dev mode or no embedded assets)
  if (!existsSync(FRONTEND_DIST)) {
    return null;
  }

  // Determine file path
  const staticPath = join(FRONTEND_DIST, url.pathname === '/' ? 'index.html' : url.pathname);

  // Try serving the file directly with Bun.file()
  const file = Bun.file(staticPath);
  if (await file.exists()) {
    return staticResponse(req, file, staticPath, fsValidators(file));
  }

  // SPA fallback: serve index.html for non-API/non-WS routes
  if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/ws')) {
    const indexPath = join(FRONTEND_DIST, 'index.html');
    const indexFile = Bun.file(indexPath);
    if (await indexFile.exists()) {
      return staticResponse(req, indexFile, indexPath, fsValidators(indexFile));
    }
  }

  return null;
}
