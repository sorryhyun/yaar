/**
 * Per-tab network log — the metadata half of what the CDP socket already sees.
 *
 * `BrowserSession` has had `Network.enable` on for the life of every socket (the
 * shield's blocklist needs it), and the `Network.*` events it produced were counted
 * and thrown away. This keeps the last {@link NETWORK_LOG_CAPACITY} of them, joined
 * on `requestId` so one entry carries the request, its response and its outcome.
 *
 * Metadata only — no headers, no bodies (issue #96 scoped those out on purpose). A
 * body is re-fetched through `yaar://http` if a caller wants it; a header is a secret
 * more often than it is a diagnostic.
 *
 * Bounded because the consumer is a model context: a busy page issues thousands of
 * requests, and "the last five hundred" answers every question this exists for.
 */

/** Entries kept per tab. The oldest is evicted first. */
export const NETWORK_LOG_CAPACITY = 500;

/** Entries a single query returns unless told otherwise. */
export const DEFAULT_QUERY_LIMIT = 50;
/** The most a single query returns, whatever it asked for. */
export const MAX_QUERY_LIMIT = 200;
/** Characters of URL an entry carries unless told otherwise; a signed CDN URL runs to kilobytes. */
export const DEFAULT_MAX_URL_LENGTH = 300;

export interface NetworkLogEntry {
  /** Monotonic per tab; poll with `afterSeq` to read only what is new. */
  seq: number;
  /** Chrome's `requestId`. A redirect chain reuses it, so it is not unique in the log. */
  requestId: string;
  url: string;
  method: string;
  /** CDP `ResourceType`: Document, XHR, Fetch, Media, Script, Image, Font, ... */
  resourceType: string;
  /** The page that issued the request — filter on this to see one navigation's traffic. */
  documentUrl: string;
  /** Epoch ms, from the tab's clock. */
  startedAt: number;
  /** Set once `Network.responseReceived` arrives (or from a redirect response). */
  status?: number;
  mimeType?: string;
  /** Where a redirect sent the request; the follow-up is its own entry. */
  redirectedTo?: string;
  fromCache?: boolean;
  /** Bytes on the wire (`encodedDataLength`), set on `loadingFinished`. */
  size?: number;
  /** ms from start to `loadingFinished`/`loadingFailed`. */
  durationMs?: number;
  /** Chrome's `errorText` when the request did not complete. */
  failed?: string;
  /** Refused by the shield's blocklist (`blockedReason: 'inspector'`). */
  blocked?: boolean;
}

export interface NetworkLogQuery {
  /** Substring of the URL, or a wildcard pattern (`*` matches anything) when it contains `*`. */
  urlPattern?: string;
  /** One or more CDP resource types, matched case-insensitively. */
  resourceType?: string | string[];
  /** Only entries that failed or were blocked. */
  failedOnly?: boolean;
  /** Only entries with `seq` greater than this. */
  afterSeq?: number;
  /** Cap on entries returned (clamped to {@link MAX_QUERY_LIMIT}). */
  limit?: number;
  /** URL truncation length; `0` returns full URLs (a caller that will re-fetch needs them). */
  maxUrlLength?: number;
}

export interface NetworkLogResult {
  entries: Array<NetworkLogEntry & { urlTruncated?: boolean }>;
  /** How many entries matched before the `limit` slice; report next to the slice. */
  totalMatched: number;
  /** Highest `seq` in the log — pass back as `afterSeq` to poll. */
  lastSeq: number;
  /** Entries currently held (bounded by `capacity`). */
  size: number;
  capacity: number;
}

// ── CDP event shapes (the fields read here; the rest is ignored) ───────────

interface RequestWillBeSent {
  requestId: string;
  documentURL?: string;
  request?: { url?: string; method?: string };
  type?: string;
  wallTime?: number;
  timestamp?: number;
  redirectResponse?: { status?: number; mimeType?: string };
}

interface ResponseReceived {
  requestId: string;
  response?: {
    status?: number;
    mimeType?: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    fromPrefetchCache?: boolean;
  };
}

interface LoadingFinished {
  requestId: string;
  timestamp?: number;
  encodedDataLength?: number;
}

interface LoadingFailed {
  requestId: string;
  timestamp?: number;
  errorText?: string;
  blockedReason?: string;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i');
}

export class NetworkLog {
  private entries: NetworkLogEntry[] = [];
  private seq = 0;
  /** In-flight entries by `requestId`, so later events find the row to update. */
  private inflight = new Map<string, { entry: NetworkLogEntry; startedTs: number }>();

  constructor(private readonly capacity = NETWORK_LOG_CAPACITY) {}

  onRequestWillBeSent(raw: unknown): void {
    const p = raw as RequestWillBeSent;
    if (!p?.requestId) return;
    // A redirect reuses the requestId: close the hop that redirected, then open the next.
    const prev = this.inflight.get(p.requestId);
    if (prev && p.redirectResponse) {
      prev.entry.status = p.redirectResponse.status;
      prev.entry.mimeType = p.redirectResponse.mimeType || prev.entry.mimeType;
      prev.entry.redirectedTo = p.request?.url;
      if (typeof p.timestamp === 'number') {
        prev.entry.durationMs = Math.max(0, Math.round((p.timestamp - prev.startedTs) * 1000));
      }
    }
    const entry: NetworkLogEntry = {
      seq: ++this.seq,
      requestId: p.requestId,
      url: p.request?.url ?? '',
      method: p.request?.method ?? 'GET',
      resourceType: p.type ?? 'Other',
      documentUrl: p.documentURL ?? '',
      startedAt: typeof p.wallTime === 'number' ? Math.round(p.wallTime * 1000) : Date.now(),
    };
    this.push(entry);
    this.inflight.set(p.requestId, { entry, startedTs: p.timestamp ?? 0 });
  }

  onResponseReceived(raw: unknown): void {
    const p = raw as ResponseReceived;
    const row = p?.requestId ? this.inflight.get(p.requestId) : undefined;
    if (!row || !p.response) return;
    row.entry.status = p.response.status;
    row.entry.mimeType = p.response.mimeType;
    const cached = Boolean(
      p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache,
    );
    if (cached) row.entry.fromCache = true;
  }

  onLoadingFinished(raw: unknown): void {
    const p = raw as LoadingFinished;
    const row = p?.requestId ? this.inflight.get(p.requestId) : undefined;
    if (!row) return;
    if (typeof p.encodedDataLength === 'number') row.entry.size = p.encodedDataLength;
    this.finish(row, p.timestamp);
  }

  onLoadingFailed(raw: unknown): void {
    const p = raw as LoadingFailed;
    const row = p?.requestId ? this.inflight.get(p.requestId) : undefined;
    if (!row) return;
    row.entry.failed = p.errorText || 'failed';
    if (p.blockedReason === 'inspector') row.entry.blocked = true;
    this.finish(row, p.timestamp);
  }

  query(q: NetworkLogQuery = {}): NetworkLogResult {
    const urlRe =
      q.urlPattern && q.urlPattern.includes('*') ? wildcardToRegExp(q.urlPattern) : null;
    const urlSub = q.urlPattern && !urlRe ? q.urlPattern.toLowerCase() : null;
    const types = q.resourceType
      ? new Set((Array.isArray(q.resourceType) ? q.resourceType : [q.resourceType]).map(lower))
      : null;
    const afterSeq = typeof q.afterSeq === 'number' ? q.afterSeq : -Infinity;

    const matched = this.entries.filter((e) => {
      if (e.seq <= afterSeq) return false;
      if (types && !types.has(e.resourceType.toLowerCase())) return false;
      if (q.failedOnly && !e.failed) return false;
      if (urlRe && !urlRe.test(e.url)) return false;
      if (urlSub && !e.url.toLowerCase().includes(urlSub)) return false;
      return true;
    });

    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, q.limit ?? DEFAULT_QUERY_LIMIT));
    const maxUrl = q.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
    // Newest last, so a `limit` slice keeps the most recent traffic.
    const slice = matched.slice(-limit).map((e) => {
      const out: NetworkLogEntry & { urlTruncated?: boolean } = { ...e };
      if (maxUrl > 0 && out.url.length > maxUrl) {
        out.url = out.url.slice(0, maxUrl) + '…';
        out.urlTruncated = true;
      }
      if (maxUrl > 0 && out.redirectedTo && out.redirectedTo.length > maxUrl) {
        out.redirectedTo = out.redirectedTo.slice(0, maxUrl) + '…';
      }
      return out;
    });

    return {
      entries: slice,
      totalMatched: matched.length,
      lastSeq: this.seq,
      size: this.entries.length,
      capacity: this.capacity,
    };
  }

  clear(): void {
    this.entries = [];
    this.inflight.clear();
  }

  private push(entry: NetworkLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      const evicted = this.entries.splice(0, this.entries.length - this.capacity);
      // An evicted row still in flight must not be updated into a log it left.
      for (const e of evicted) {
        const row = this.inflight.get(e.requestId);
        if (row && row.entry === e) this.inflight.delete(e.requestId);
      }
    }
  }

  private finish(row: { entry: NetworkLogEntry; startedTs: number }, ts?: number): void {
    if (typeof ts === 'number' && row.startedTs) {
      row.entry.durationMs = Math.max(0, Math.round((ts - row.startedTs) * 1000));
    }
    this.inflight.delete(row.entry.requestId);
  }
}

const lower = (s: string) => String(s).toLowerCase();
