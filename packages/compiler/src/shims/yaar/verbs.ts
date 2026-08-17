// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Verb functions and the raw `window.yaar` global.
 *
 * The verb proxy returns a JSON envelope; callVerb() unwraps it, so verb
 * functions already return parsed data. The typed helpers just pass through.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const y = (window as any).yaar;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asText(data: any): string {
  return typeof data === 'string' ? data : data != null ? JSON.stringify(data) : '';
}

// ── Verb functions ───────────────────────────────────────────────

export async function read<T = unknown>(uri: string): Promise<T> {
  return y.read(uri);
}

/**
 * Invoke a verb. An **array** payload runs the same URI once per element, in order, as
 * one call — the payload-axis complement to brace expansion in the URI. It stops at the
 * first failure and names the index that failed.
 */
export async function invoke<T = unknown>(
  uri: string,
  payload?: Record<string, unknown> | Record<string, unknown>[],
): Promise<T> {
  return y.invoke(uri, payload);
}

export async function list<T = unknown>(uri: string): Promise<T> {
  return y.list(uri);
}

export async function describe<T = unknown>(uri: string): Promise<T> {
  return y.describe(uri);
}

export async function del(uri: string): Promise<unknown> {
  return y.delete(uri);
}

export async function subscribe(uri: string, callback: (uri: string) => void): Promise<() => void> {
  return y.subscribe(uri, callback);
}

/**
 * The canonical way for an app to make an HTTP request.
 *
 * Deliberately thin — it is `window.fetch`, and its value is that the contract is
 * named and documented rather than folklore:
 *
 * - **Cross-origin** calls are routed through YAAR's proxy, which enforces SSRF
 *   protection, the domain allowlist (prompting the user on a miss), a 10 MB body
 *   cap, and a 30-second timeout. The app's `app.json` must declare `yaar://http`.
 * - **Relative and same-origin** calls behave like normal fetch and carry the
 *   iframe token.
 * - Either way you get a standard `Response` — `json()`, `text()`, `blob()`,
 *   `arrayBuffer()`, and real `Headers`. Binary bodies survive intact.
 * - Cookies are kept in a jar scoped to (session, app), so one app cannot read
 *   another's session with an upstream service.
 *
 * Prefer this over `invoke('yaar://http', …)`, which returns YAAR's internal
 * envelope and has led every app that used it to hand-roll its own response type.
 *
 * Note it reads `window.fetch` at call time rather than capturing it. Today's
 * wrapper makes that redundant — the proxy ships as a blocking classic script in
 * `<head>` and app code as a deferred module, so the swap is guaranteed to have
 * happened first. It is written this way so that guarantee stays an implementation
 * detail of the wrapper: the proxy installs itself by *replacing* `window.fetch`,
 * and a captured reference would silently bypass it the moment that ordering
 * changed.
 */
export function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return window.fetch(input, init);
}

/**
 * One frame of a stream subscription. `seq` is monotonic per subscription — a gap
 * means frames were dropped; `kind` is source-defined.
 */
export interface StreamFrame {
  uri: string;
  seq: number;
  kind: string;
  data: unknown;
  ts: number;
}

/**
 * Stream a yaar:// URI: like {@link subscribe}, but the server pushes typed frames
 * with payloads instead of bare change pings. `opts.kinds` narrows delivery to the
 * listed frame kinds. Returns an unsubscribe thunk.
 */
export async function stream(
  uri: string,
  onFrame: (frame: StreamFrame) => void,
  opts?: { kinds?: string[] },
): Promise<() => void> {
  return y.stream(uri, onFrame, opts);
}

// ── Sub-object re-exports ────────────────────────────────────────

export const storage = y.storage;

/**
 * Any spelling of a stored file, reduced to a storage-root-relative path — or `null`
 * when the reference names something that is not storage.
 *
 * One file has four names, and which one you are holding depends on the layer that
 * handed it over: `shared/anima/dragon.png` from a listing, `yaar://storage/…` from a
 * verb, `yaar://apps/self/storage/…` from an app.json permission or an agent,
 * `/api/storage/…` from an HTTP route. All four resolve to the same bytes; every
 * `storage.*` method already accepts all four, so reach for this only when you need the
 * path *itself* — to store in a document, to take a dirname, or to ask "is this a
 * stored file or a remote URL?".
 *
 * `null` means not-storage (an `https://` URL, a `data:` URL, a non-storage `yaar://`
 * resource) or a path containing `..`, which names no resource. It does **not** mean
 * forbidden: this runs in the iframe and cannot see what a caller delegated to this
 * window, so a path outside the app's own trees still resolves and the server answers.
 *
 * `self` is deliberately left unexpanded — `/api/storage` resolves it against the
 * calling app, and a second copy of that mapping here would be free to drift (and is
 * simply wrong under a devtools preview, where the principal is `preview--{id}`).
 */
export function storagePath(ref: string | undefined | null): string | null {
  return y.storage.path(ref);
}
export const app = y.app;
export const notifications = y.notifications;
export const windows = y.windows;
export const links = y.links;
