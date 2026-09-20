/**
 * YAAR's service worker: the shell, so an installed YAAR opens like an app.
 *
 * ## What this is for
 *
 * A phone does not keep a backgrounded tab running. Android discards it, and reopening
 * YAAR from the home screen is a cold document load — which, without this file, is a
 * round trip to a server that may be a Termux process on the same phone still waking up,
 * or a laptop on a network the phone has not reassociated with yet. The user sees a white
 * page, or the browser's offline error, for a server that is perfectly fine. Caching the
 * shell makes that load local: the desktop paints, and the WebSocket reconnect (which has
 * always been able to wait and retry) is the only thing left waiting.
 *
 * It is explicitly *not* a way to run YAAR in the background. Nothing here talks to the
 * agent; the page still has to be open for that.
 *
 * ## What it will and will not touch
 *
 * Only three kinds of request, and everything else is left to the browser untouched —
 * no `respondWith`, no interception:
 *
 *   1. **The desktop document** (`destination === 'document'`). Network-first with a
 *      short deadline, then the cached shell. Network-first because the bundle filenames
 *      are content-hashed and baked into the HTML, so a stale shell points at scripts
 *      that no longer exist; the deadline is there because a phone whose server is
 *      unreachable would otherwise sit on a `fetch` for half a minute with a perfectly
 *      good copy on disk.
 *   2. **Content-hashed build output** (`main-a1b2c3d4.js` and friends). Cache-first and
 *      never revalidated — a change to the bytes is a change to the URL.
 *   3. **Fixed-name assets from `public/`** — the 10.5 MB of webfonts, the icons, the
 *      manifest. Stale-while-revalidate: served instantly, replaced in the background.
 *      Cache-first would strand a font swap forever; network-first would spend the
 *      10.5 MB on a conditional request before the first glyph.
 *
 * The exclusions matter as much. `/api/*` and the WebSocket are live state and are never
 * cached. App iframe documents are `destination === 'iframe'`, not `'document'`, so they
 * fall through even in the local-dev origin mode where an app shares this origin — an app
 * served from a stale cache with a live iframe token is not a thing we want to debug.
 */

/** Bump to invalidate everything. `activate` deletes every cache that is not this one. */
const CACHE = 'yaar-shell-v1';

/** The key the desktop document is stored under, whatever path it was requested at. */
const SHELL_KEY = '/index.html';

/**
 * How long the network gets to answer a document request before the cached shell wins.
 *
 * Short on purpose: this runs when the user has just tapped the icon and is looking at a
 * blank screen. Losing the race costs nothing — the fetch keeps going and refreshes the
 * cache for next time.
 */
const DOCUMENT_NETWORK_TIMEOUT_MS = 2500;

/** `name-<hash>.js|css`, and the sourcemap beside it — see `routes/static.ts`. */
const HASHED_BUILD_OUTPUT = /-[A-Za-z0-9]{8,}\.(?:js|css)(?:\.map)?$/;

/** Fixed-name things copied out of `public/`: webfonts, icons, the manifest. */
const PUBLIC_ASSET = /\.(?:woff2?|ttf|otf|eot|png|jpg|jpeg|gif|svg|ico|webp)$|^\/manifest\.json$/;

self.addEventListener('install', (event) => {
  // The shell is not precached: its bundle filenames change every build, so the only
  // copy worth having is one this worker saw the page actually use.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Put a response in the cache, if it is one worth keeping.
 *
 * An opaque cross-origin response has status 0 and no readable body; storing it would
 * mean serving an unknowable thing back. A redirect stored against the requested URL
 * would replay as a redirect the page cannot follow from the cache.
 */
async function store(key, response) {
  if (!response || !response.ok || response.type === 'opaque' || response.redirected) return;
  const cache = await caches.open(CACHE);
  await cache.put(key, response.clone());
}

/**
 * Network, but give up waiting after `DOCUMENT_NETWORK_TIMEOUT_MS` if we have a shell.
 *
 * The request is not aborted when the deadline passes — it is left running so its
 * response still refreshes the cache. Only the waiting stops.
 */
async function documentResponse(request) {
  const cached = await caches.match(SHELL_KEY);

  const network = fetch(request)
    .then((response) => {
      void store(SHELL_KEY, response);
      return response;
    })
    .catch(() => null);

  if (!cached) {
    // Nothing to fall back to, so the network is the only answer there is. A failure
    // here is the browser's own offline page, exactly as without this worker.
    return (await network) ?? fetch(request);
  }

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DOCUMENT_NETWORK_TIMEOUT_MS));
  return (await Promise.race([network, timeout])) ?? cached;
}

/** Cache-first, for URLs that carry their own content hash. */
async function immutableResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  void store(request, response);
  return response;
}

/** Stale-while-revalidate, for fixed names whose bytes may change under them. */
async function revalidatingResponse(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      void store(request, response);
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  return (await network) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live state, never a cache: the REST surface, and the dev bundler's reload stream.
  if (url.pathname.startsWith('/api/')) return;

  if (request.destination === 'document') {
    event.respondWith(documentResponse(request));
    return;
  }
  if (HASHED_BUILD_OUTPUT.test(url.pathname)) {
    event.respondWith(immutableResponse(request));
    return;
  }
  if (PUBLIC_ASSET.test(url.pathname)) {
    event.respondWith(revalidatingResponse(request));
  }
});
