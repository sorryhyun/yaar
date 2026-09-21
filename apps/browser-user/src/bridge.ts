/**
 * HTTP helper for `POST /api/bridge` (the user's real Chrome tabs via the Bridge extension).
 * Mirrors `browserPost` from the yaar-web shim; `@bundled/yaar-web` itself drives the headless
 * browser, not the user's live tabs, so it is not used here. Every request carries the iframe
 * token (`window.__YAAR_TOKEN__`) in the `X-Iframe-Token` header.
 *
 * app.json still declares `"bundles": ["yaar-web"]` though nothing imports that SDK: `bundles` is
 * also the capability the server checks (`requireBundle`) on `/api/bridge`. Deleting the
 * declaration 403s this app out of the endpoint.
 */

import { errMsg } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { BridgeEnvelopeSchema } from './schema';

/** A single real browser tab as reported by the Bridge. */
export interface Tab {
  id: number;
  url: string;
  title: string;
  active?: boolean;
  audible?: boolean;
  isSelf?: boolean;
  /** True when the agent is already granted full use (control + read) of this tab's origin. */
  allowed?: boolean;
}

/** Standard JSON envelope returned by every `/api/bridge` action. */
export interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface ListTabsData {
  fidelity: 'bridge' | 'os-signals';
  connected: boolean;
  tabs: Tab[];
}

export interface PresenceData {
  fidelity: 'bridge' | 'os-signals';
  connected: boolean;
  tabCount: number;
  activeTab: Tab | null;
}

export interface ExtractData {
  id: number;
  url: string;
  title: string;
  truncated: boolean;
  text: string;
}

export interface ScreenshotData {
  id: number;
  url: string;
  title: string;
  /** WebP data URL of the visible tab (transcoded from PNG in the extension). */
  dataUrl: string;
}

interface BridgeRequest {
  action: string;
  tabId?: number;
  tabIds?: number[];
  groupTitle?: string;
  index?: number;
  windowId?: number;
  maxChars?: number;
  selector?: string;
  text?: string;
  submit?: boolean;
  deltaY?: number;
  top?: number;
  url?: string;
}

function bridgeHeaders(): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

async function bridgePost<T>(body: BridgeRequest): Promise<BridgeEnvelope<T>> {
  try {
    const res = await fetch('/api/bridge', {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify(body),
    });
    // Validate the envelope wrapper; `data` is cast to the caller's `<T>` afterwards.
    const parsed = z.safeParse(BridgeEnvelopeSchema, await res.json());
    if (!parsed.success) {
      console.error('bridge envelope failed validation', parsed.error.issues);
      throw new Error('The bridge returned an unrecognized response.');
    }
    return parsed.data as BridgeEnvelope<T>;
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export function listTabs(): Promise<BridgeEnvelope<ListTabsData>> {
  return bridgePost<ListTabsData>({ action: 'listTabs' });
}

/** Lightweight presence snapshot (connected, tab count, active tab). */
export function presence(): Promise<BridgeEnvelope<PresenceData>> {
  return bridgePost<PresenceData>({ action: 'presence' });
}

export function focus(tabId: number): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'focus', tabId });
}

/** Close a tab. Refused (403) for YAAR's own tab; may prompt per-origin consent. */
export function close(tabId: number): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'close', tabId });
}

/** Group tabs together, optionally under a title. May prompt per-origin consent. */
export function group(
  tabId: number,
  tabIds?: number[],
  groupTitle?: string,
): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'group', tabId, tabIds, groupTitle });
}

/** Move a tab to a new index / window. May prompt per-origin consent. */
export function move(
  tabId: number,
  index?: number,
  windowId?: number,
): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'move', tabId, index, windowId });
}

/** Show a tracking cursor / highlight on a tab. */
export function track(tabId: number): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'track', tabId });
}

/**
 * Grant the agent full use (view / scroll / click / read) of a tab's origin. A user consent act —
 * proactively grants tab-control + content-read for that origin so the agent needs no further prompts.
 */
export function allow(tabId: number): Promise<BridgeEnvelope<string>> {
  return bridgePost<string>({ action: 'allow', tabId });
}

/** Extract page text from a tab. May prompt per-origin consent. */
export function extract(tabId: number, maxChars?: number): Promise<BridgeEnvelope<ExtractData>> {
  return bridgePost<ExtractData>({ action: 'extract', tabId, maxChars });
}

/** Capture the visible tab (WebP data URL). Content-consent-gated; the tab must be focused. */
export function screenshot(tabId: number): Promise<BridgeEnvelope<ScreenshotData>> {
  return bridgePost<ScreenshotData>({ action: 'screenshot', tabId });
}

/** Click the element matching `selector`. Tab-control consent-gated (a page mutation). */
export function click(tabId: number, selector: string): Promise<BridgeEnvelope<unknown>> {
  return bridgePost<unknown>({ action: 'click', tabId, selector });
}

/** Type `text` into the field matching `selector`, optionally submitting. Tab-control consent-gated. */
export function typeText(
  tabId: number,
  selector: string,
  text: string,
  submit?: boolean,
): Promise<BridgeEnvelope<unknown>> {
  return bridgePost<unknown>({ action: 'type', tabId, selector, text, submit });
}

/** Scroll the page — into view of `selector`, to absolute `top`, or by `deltaY` px. Tab-control gated. */
export function scroll(
  tabId: number,
  opts?: { selector?: string; deltaY?: number; top?: number },
): Promise<BridgeEnvelope<unknown>> {
  return bridgePost<unknown>({ action: 'scroll', tabId, ...opts });
}

/** Load `url` in the tab. Tab-control consent-gated (a navigation). */
export function navigate(tabId: number, url: string): Promise<BridgeEnvelope<unknown>> {
  return bridgePost<unknown>({ action: 'navigate', tabId, url });
}
