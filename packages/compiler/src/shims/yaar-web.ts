// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-web.
 *
 * Ergonomic browser automation via direct HTTP routes.
 * Requires "yaar-web" in app.json bundles field to import.
 *
 * Usage:
 *   import { open, click, extract } from '@bundled/yaar-web';
 *   await open('https://example.com');
 *   await click({ text: 'Sign In' });
 *   const content = await extract();
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function browserHeaders(): Record<string, string> {
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

async function browserPost<T>(body: Record<string, unknown>, budgetMs?: number): Promise<T> {
  if (!body.browserId) body.browserId = '0';
  const res = await fetch('/api/browser', {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify(body),
    // Bound stuck CDP actions — most have no server-side timeout. When an action
    // carries its own budget (evaluate, scrollToBottom), stay above it so the
    // server's error arrives instead of a bare client abort.
    signal: AbortSignal.timeout(Math.max(120_000, (budgetMs ?? 0) + 15_000)),
  });
  const json = await res.json().catch(() => null);
  if (json === null) {
    throw new Error(`browser action "${String(body.action)}" failed: HTTP ${res.status}`);
  }
  return json as T;
}

// ── Tab lifecycle ───────────────────────────────────────────────

/** Create a new browser tab without navigating. Returns browserId info. */
export async function create(opts?: {
  browserId?: string;
  mobile?: boolean;
  visible?: boolean;
  live?: boolean;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'create', browserId, ...params });
}

/** List all open browser tabs. */
export async function listTabs() {
  return browserPost({ action: 'list_tabs' });
}

/** Close a browser tab. */
export async function closeTab(browserId?: string) {
  return browserPost({ action: 'close_tab', browserId });
}

// ── Navigation ──────────────────────────────────────────────────

export async function open(
  url: string,
  opts?: {
    browserId?: string;
    mobile?: boolean;
    visible?: boolean;
    live?: boolean;
    waitUntil?: string;
  },
) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'open', browserId, url, ...params });
}

export async function scroll(opts: {
  direction: 'up' | 'down';
  amount?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'scroll', browserId, ...params });
}

/**
 * Scroll to the bottom one viewport at a time, dwelling after each step so
 * lazy-loaded content can extend the page.
 */
export async function scrollToBottom(opts?: {
  maxSteps?: number;
  dwellMs?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  const budget = (params.maxSteps ?? 40) * (params.dwellMs ?? 400);
  return browserPost({ action: 'scroll_to_bottom', browserId, ...params }, budget);
}

export async function navigate(
  urlOrOpts: string | { direction: 'back' | 'forward'; browserId?: string },
  browserId?: string,
) {
  if (typeof urlOrOpts === 'string') {
    return browserPost({ action: 'navigate', browserId, url: urlOrOpts });
  }
  const { browserId: bid, ...params } = urlOrOpts;
  return browserPost({ action: 'navigate', browserId: bid, ...params });
}

// ── Interaction ─────────────────────────────────────────────────

export async function click(opts: {
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  index?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'click', browserId, ...params });
}

export async function type(opts: { selector: string; text: string; browserId?: string }) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'type', browserId, ...params });
}

export async function press(opts: { key: string; selector?: string; browserId?: string }) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'press', browserId, ...params });
}

export async function hover(opts: {
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'hover', browserId, ...params });
}

// ── Observation ─────────────────────────────────────────────────

export async function waitFor(opts: { selector: string; timeout?: number; browserId?: string }) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'wait_for', browserId, ...params });
}

export async function screenshot(opts?: {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'screenshot', browserId, ...params });
}

export async function extract(opts?: {
  selector?: string;
  mainContentOnly?: boolean;
  maxTextLength?: number;
  maxLinks?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'extract', browserId, ...params });
}

export async function extractImages(opts?: {
  selector?: string;
  mainContentOnly?: boolean;
  minWidth?: number;
  minHeight?: number;
  extensions?: string[];
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'extract_images', browserId, ...params });
}

/**
 * Page HTML. Default is `document.body.innerHTML` — a fragment, no doctype/head/title.
 * `outerHTML: true` includes the element's own tag (whole document when no selector);
 * `includeMeta: true` returns `{ html, url, title, readyState }` instead of a string.
 */
export async function html(opts?: {
  selector?: string;
  outerHTML?: boolean;
  includeMeta?: boolean;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'html', browserId, ...params });
}

/**
 * Evaluate an expression in the page. Promises are awaited, so a page-side wait
 * counts against `timeoutMs` (default 15s, max 120s).
 */
export async function evaluate(opts: {
  expression: string;
  timeoutMs?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'evaluate', browserId, ...params }, params.timeoutMs);
}

// ── Shield (request blocking, init script) ──────────────────────
// Provider-wide: every tab, including popups Chrome opens later. See issue #94.

export async function setRequestBlocking(opts: {
  enabled: boolean;
  rules?: { hosts?: string[]; urlPatterns?: string[]; patterns?: string[] };
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'set_request_blocking', browserId, ...params });
}

export async function getRequestBlockStats(opts?: { browserId?: string }) {
  return browserPost({ action: 'get_request_block_stats', browserId: opts?.browserId });
}

export async function setInitScript(opts: { script: string; browserId?: string }) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'set_init_script', browserId, ...params });
}

// ── Network log (per tab, metadata only) ────────────────────────

export async function getNetworkLog(opts?: {
  urlPattern?: string;
  resourceType?: string | string[];
  failedOnly?: boolean;
  afterSeq?: number;
  limit?: number;
  maxUrlLength?: number;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'get_network_log', browserId, ...params });
}

// ── Visual ──────────────────────────────────────────────────────

export async function annotate(browserId?: string) {
  return browserPost({ action: 'annotate', browserId });
}

export async function removeAnnotations(browserId?: string) {
  return browserPost({ action: 'remove_annotations', browserId });
}

// ── Cookies ────────────────────────────────────────────────────

export async function getCookies(opts?: { urls?: string[]; browserId?: string }) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'get_cookies', browserId, ...params });
}

export async function setCookie(opts: {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  url?: string;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'set_cookie', browserId, ...params });
}

export async function deleteCookies(opts: {
  name: string;
  domain?: string;
  path?: string;
  url?: string;
  browserId?: string;
}) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'delete_cookies', browserId, ...params });
}

// ── Downloads ──────────────────────────────────────────────────

/**
 * A file saved out of the remote browser and into `shared/browser/downloads/`.
 */
export interface BrowserDownload {
  /** File name inside `shared/browser/downloads/`. */
  name: string;
  /** Where the bytes came from. */
  url: string;
  /** Root-relative storage path. */
  path: string;
  /** The same file as a `yaar://storage/...` URI. */
  uri: string;
  bytes: number;
  /** Epoch ms. */
  at: number;
}

/**
 * Save a file out of the remote browser.
 *
 * The transfer is made **by the tab**, so it carries that tab's cookies: a file behind a
 * login downloads here exactly as it would for a human sitting in front of that browser.
 * The bytes go from Chrome straight to the server's disk and never through this app, so
 * size is bounded by the disk rather than by a response cap.
 *
 * Two shapes, matching the two ways a download starts:
 *
 * - `{ url }` — ask the tab to download something. Omit `url` to save the page itself,
 *   which is the common case ("save what I am looking at").
 * - `{ id }` — claim a download Chrome performed on its own. The page's own download
 *   button, an `<a download>`, an attachment navigation: those are captured as they
 *   happen and announced on the session's event stream with an `id`. This redeems it.
 *
 * `filename` is a suggestion; the server sanitises it and may add an extension the
 * response's type requires (an extensionless PDF gets `.pdf`).
 */
export async function download(opts?: {
  url?: string;
  id?: string;
  filename?: string;
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  // A download is a transfer, not a command: it outlives the default client budget on
  // anything larger than a paper, so the budget is raised rather than the transfer cut.
  return browserPost<{ ok: boolean; data?: BrowserDownload; error?: string }>(
    { action: 'download', browserId, ...params },
    180_000,
  );
}

/**
 * Downloads Chrome finished writing that nothing has claimed yet, newest first.
 *
 * The event stream is the primary channel — this is what an app that reloaded, or missed
 * a frame, asks instead of losing the file. `available: false` means this Chrome refused
 * download capture altogether, which is a different answer from "nothing was downloaded".
 */
export async function listDownloads(browserId?: string) {
  return browserPost<{
    ok: boolean;
    error?: string;
    data?: {
      available: boolean;
      pending: {
        id: string;
        url: string;
        suggestedFilename: string;
        bytes: number;
        at: number;
      }[];
    };
  }>({ action: 'list_downloads', browserId });
}

// ── Session management (deprecated — use listTabs / closeTab) ───

/** @deprecated Use `listTabs()` instead. */
export async function listSessions() {
  return listTabs();
}

/** @deprecated Use `closeTab()` instead. */
export async function closeSession(browserId?: string) {
  return closeTab(browserId);
}
