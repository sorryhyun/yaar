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

async function browserPost<T>(body: Record<string, unknown>): Promise<T> {
  if (!body.browserId) body.browserId = '0';
  const res = await fetch('/api/browser', {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Tab lifecycle ───────────────────────────────────────────────

/** Create a new browser tab without navigating. Returns browserId info. */
export async function create(opts?: { browserId?: string; mobile?: boolean; visible?: boolean }) {
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
  opts?: { browserId?: string; mobile?: boolean; visible?: boolean; waitUntil?: string },
) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'open', browserId, url, ...params });
}

export async function scroll(opts: { direction: 'up' | 'down'; browserId?: string }) {
  const { browserId, ...params } = opts;
  return browserPost({ action: 'scroll', browserId, ...params });
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
  browserId?: string;
}) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'extract_images', browserId, ...params });
}

export async function html(opts?: { selector?: string; browserId?: string }) {
  const { browserId, ...params } = opts ?? {};
  return browserPost({ action: 'html', browserId, ...params });
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

// ── Session management (deprecated — use listTabs / closeTab) ───

/** @deprecated Use `listTabs()` instead. */
export async function listSessions() {
  return listTabs();
}

/** @deprecated Use `closeTab()` instead. */
export async function closeSession(browserId?: string) {
  return closeTab(browserId);
}
