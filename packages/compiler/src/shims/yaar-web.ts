// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-web.
 *
 * Ergonomic browser automation wrapping yaar://browser/ verbs.
 * Requires "yaar-web" in app.json bundles field to import.
 *
 * Usage:
 *   import { open, click, extract } from '@bundled/yaar-web';
 *   await open('https://example.com');
 *   await click({ text: 'Sign In' });
 *   const content = await extract();
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const y = (window as any).yaar;

function browserUri(browserId?: string): string {
  return `yaar://browser/${browserId ?? '0'}`;
}

async function browserInvoke(action: string, opts?: Record<string, unknown>) {
  const { browserId, ...params } = opts ?? {};
  return y.invoke(browserUri(browserId), { action, ...params });
}

// ── Navigation ──────────────────────────────────────────────────

export async function open(
  url: string,
  opts?: { browserId?: string; mobile?: boolean; visible?: boolean; waitUntil?: string },
) {
  const { browserId, ...params } = opts ?? {};
  return y.invoke(browserUri(browserId), { action: 'open', url, ...params });
}

export async function scroll(opts: { direction: 'up' | 'down'; browserId?: string }) {
  return browserInvoke('scroll', opts);
}

export async function navigateBack(browserId?: string) {
  return y.invoke(browserUri(browserId), { action: 'navigate', direction: 'back' });
}

export async function navigateForward(browserId?: string) {
  return y.invoke(browserUri(browserId), { action: 'navigate', direction: 'forward' });
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
  return browserInvoke('click', opts);
}

export async function type(opts: { selector: string; text: string; browserId?: string }) {
  return browserInvoke('type', opts);
}

export async function press(opts: { key: string; selector?: string; browserId?: string }) {
  return browserInvoke('press', opts);
}

export async function hover(opts: {
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  browserId?: string;
}) {
  return browserInvoke('hover', opts);
}

// ── Observation ─────────────────────────────────────────────────

export async function waitFor(opts: { selector: string; timeout?: number; browserId?: string }) {
  return browserInvoke('wait_for', opts);
}

export async function screenshot(opts?: {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  browserId?: string;
}) {
  return browserInvoke('screenshot', opts);
}

export async function extract(opts?: {
  selector?: string;
  mainContentOnly?: boolean;
  maxTextLength?: number;
  maxLinks?: number;
  browserId?: string;
}) {
  return browserInvoke('extract', opts);
}

export async function extractImages(opts?: {
  selector?: string;
  mainContentOnly?: boolean;
  browserId?: string;
}) {
  return browserInvoke('extract_images', opts);
}

export async function html(opts?: { selector?: string; browserId?: string }) {
  return browserInvoke('html', opts);
}

// ── Visual ──────────────────────────────────────────────────────

export async function annotate(browserId?: string) {
  return y.invoke(browserUri(browserId), { action: 'annotate' });
}

export async function removeAnnotations(browserId?: string) {
  return y.invoke(browserUri(browserId), { action: 'remove_annotations' });
}

// ── Session management ──────────────────────────────────────────

export async function listSessions() {
  return y.list('yaar://browser/');
}

export async function closeSession(browserId?: string) {
  return y.delete(browserUri(browserId));
}
