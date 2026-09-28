---
name: external-fetch
description: Read before httpFetch of big files, rate-limited sites or hotlinked images, or putting a fetched URL in href/src — proxy caps, scraping traps.
audience: agent
---

## External Fetch

### The proxy caps every response at 10MB and 30s

`httpFetch` crosses the server's proxy, which **fails** a response past 10MB or a request
past 30s — it does not "run slowly". Anything that can exceed either goes through a
Range loop, and crawl and transcribe built the same one:

```ts
const first = await httpFetch(url, { headers: { Range: `bytes=0-${CHUNK - 1}` } });
if (first.status === 200) {                       // server ignored Range
  const blob = await first.blob();
  if (blob.size !== Number(first.headers.get('content-length'))) throw new Error('truncated');
  return blob;
}
if (first.status !== 206) throw new Error(`HTTP ${first.status} to a Range request`);
// loop: validate each Content-Range start/end/total before appending
```

- A `200` to a Range request means the server ignored it — trust it only if the length
  matches exactly.
- **Use the loop for every size**, not only big files (transcribe): a special-cased
  "small file" path breaks silently the day a file crosses the cap.
- Never trust a saved file's presence; compare its byte length to the reported total. A
  throttled transfer arrives as a short file, not an exception.

*Seen in:* crawl `src/net.ts` (`getChunked`) and `src/booru/tagdb.ts`, transcribe
`src/media/fetch.ts`.

### Probe with a 1-byte Range GET — never HEAD, never an aborted GET

`/api/storage/…` and similar routes refuse HEAD, but answer `Range: bytes=0-0` with
`206` and `Content-Range: bytes 0-0/<total>`: the full size for one byte. Cancelling a
full GET after its headers arrive is worse than it looks: onnxruntime's *next* request
for the same URL came back non-ok. *Seen in:* anima `src/ml/runtime.ts` (`probeUrl`).

### Rate limits: one limiter per endpoint class, and 404 can be a 429

crawl's `RateLimiter` (a token bucket, rate/burst read through closures so a settings
change applies mid-job) is shared per endpoint class (API vs image CDN). Its `get()`:

- retries 429/5xx with exponential backoff **without spending a retry attempt** on a
  throttle;
- treats `2xx` + `x-ratelimit-remaining: 0` like a 429;
- treats a bare header-less 404 from a known-throttling CDN as "maybe throttled", with
  **fewer** retries, so a truly deleted resource still fails in bounded time.

### Hotlink-protected images: fetch the bytes yourself

Many image CDNs serve only requests carrying the page's own `Referer`, which neither a
bare `<img src>` in an iframe nor an agent's own fetch can send — the symptom is a 403 or
a placeholder image. The app's `httpFetch` sets `Referer`, downloads once, then (a)
writes the original into the shared tree and (b) inlines a downscaled copy as an image
content block (`command-design` topic). Never hand the agent the remote URL to fetch
itself. Cap how many folders pile up in the commons. *Seen in:* dc-comics
`src/lib/images.ts`, thesingularity-reader `src/dc/images.ts`.

### URLs into `href`/`src`: allowlist the scheme at the interpolation site

`sanitizeHtml` is the backstop, not the fix. At every place a fetched string becomes an
`href`/`src`, strip control and whitespace characters (`java\tscript:` defeats naive
checks), parse with `new URL()`, and allow only `http:`/`https:`. Do **not** instead
narrow DOMPurify's URI regex to `^https?://`: it governs every URI-ish attribute and
silently strips app chrome (`target`, `rel`, `loading`). *Seen in:* recent-papers
`src/sanitize.ts` (`safeUrlRaw`).

### Persisted tokens need a real file extension

Storage reads a path with no extension as binary and returns a placeholder sentence
("Binary file ((no extension)) — cannot be read as text…") in place of the content. github
stored its token at `token`, read the placeholder back, and put it in
`Authorization: Bearer …` — every request failed with an opaque "invalid header value".
Store `{ "value": "…" }` at `token.json`, and gate every header build on a positive
charset check (`/^[A-Za-z0-9_.~+/=-]+$/`) so any unusable value reads as signed-out.
*Seen in:* github `src/secret.ts`.

### Two sources, one record type: go through accessors

When merging two APIs' records (arXiv + Hugging Face), UI code never reads fields
directly; a named accessor per field knows each source's shape, dedupe keys on a
normalized id (strip `vN`), and the merge picks the winning source **per field**. "Today"
is a named calendar's day boundary, not `Date.now() - 86400000` — HF stamps some records
later than now. *Seen in:* recent-papers `src/paper-utils.ts`, `src/merge.ts`.

### Cache what was expensive to fetch

Cache scraped or multi-step results in `appStorage` keyed by source URL + TTL, so a
remount rehydrates instantly instead of re-running the fetch — and a replayed command
does not re-spend a rate-limit budget.
