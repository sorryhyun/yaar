/**
 * Local HTTP helper for the YAAR Bridge REST route.
 *
 * Mirrors `browserPost` from the yaar-web shim, but talks to `POST /api/bridge`
 * (the user's REAL Chrome tabs via the Bridge extension) instead of the
 * server-side headless browser. Do NOT use `@bundled/yaar-web` here — that SDK
 * drives the headless browser, not the user's live tabs.
 *
 * Every request carries the iframe token (`window.__YAAR_TOKEN__`) in the
 * `X-Iframe-Token` header, exactly like the Browser app posts to `/api/browser`.
 */

/** A single real browser tab as reported by the Bridge. */
export interface Tab {
  id: number;
  url: string;
  title: string;
  active?: boolean;
  audible?: boolean;
  isSelf?: boolean;
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

interface BridgeRequest {
  action: string;
  tabId?: number;
  tabIds?: number[];
  groupTitle?: string;
  index?: number;
  windowId?: number;
  maxChars?: number;
}

function bridgeHeaders(): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

/** POST a body to `/api/bridge` and return the parsed JSON envelope. */
async function bridgePost<T>(body: BridgeRequest): Promise<BridgeEnvelope<T>> {
  try {
    const res = await fetch('/api/bridge', {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify(body),
    });
    return (await res.json()) as BridgeEnvelope<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Typed helpers ────────────────────────────────────────────────────────

/** List the user's real browser tabs. */
export function listTabs(): Promise<BridgeEnvelope<ListTabsData>> {
  return bridgePost<ListTabsData>({ action: 'listTabs' });
}

/** Lightweight presence snapshot (connected, tab count, active tab). */
export function presence(): Promise<BridgeEnvelope<PresenceData>> {
  return bridgePost<PresenceData>({ action: 'presence' });
}

/** Focus (activate) a tab. */
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

/** Extract page text from a tab. May prompt per-origin consent. */
export function extract(tabId: number, maxChars?: number): Promise<BridgeEnvelope<ExtractData>> {
  return bridgePost<ExtractData>({ action: 'extract', tabId, maxChars });
}
