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

export async function navigate(url: string, browserId?: string) {
  return browserPost({ action: 'navigate', browserId, url });
}

export async function navigateBack(browserId?: string) {
  return browserPost({ action: 'navigate', browserId, direction: 'back' });
}

export async function navigateForward(browserId?: string) {
  return browserPost({ action: 'navigate', browserId, direction: 'forward' });
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

// ── Session management ──────────────────────────────────────────

export async function listSessions() {
  const res = await fetch('/api/browser/sessions', { headers: browserHeaders() });
  return res.json();
}

export async function closeSession(browserId?: string) {
  const res = await fetch(`/api/browser/${browserId ?? '0'}`, {
    method: 'DELETE',
    headers: browserHeaders(),
  });
  return res.json();
}
