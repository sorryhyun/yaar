/**
 * Bridge actions — the dispatch layer behind `POST /api/bridge`.
 *
 * Observe and manage the user's REAL browser tabs (via the YAAR Bridge extension). This is the
 * only server-side entry point to the bridge; it mirrors `features/browser/actions.ts` (which backs
 * `POST /api/browser` for the headless sandbox). The `browser-user` app iframe calls it directly
 * (iframe-token auth); monitor agents reach it only by driving that app through the App Protocol
 * (`app_command`/`app_query`). There is deliberately no `yaar://browser` verb namespace — control
 * of the user's real browser is app-mediated, so it is always visible as a window and never a raw,
 * silently-callable agent capability. See `0607plan.md` (Slice 4).
 */

import { BRIDGE_CONTENT_MAX_CHARS } from '@yaar/shared';
import { getBridgeHub, type BrowserTab } from './bridge.js';
import { enforceTabControlGuard, enforceContentReadGuard } from './guards.js';

/** Tab-targeted actions. `focus/close/group/move` manage a tab; `track` is a cosmetic cue;
 *  `extract` returns the tab's page text (separately consent-gated). */
const TAB_ACTIONS = ['focus', 'close', 'group', 'move', 'track', 'extract'] as const;
type TabAction = (typeof TAB_ACTIONS)[number];

export interface BridgeActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** HTTP status hint for the route (default 200 ok / 400 bad-request / 403 consent / 404 gone). */
  status?: number;
}

/** A short, human-readable name for a tab, for overlay/log labels. */
function tabName(t: BrowserTab): string {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url || `tab ${t.id}`;
  }
}

/** The label the extension paints on its cursor/tracking overlay for a given action. */
function activityLabel(action: string, t: BrowserTab): string {
  const verb = action === 'track' ? 'watching' : action === 'extract' ? 'reading' : action;
  return `YAAR · ${verb} · ${tabName(t)}`;
}

/**
 * Dispatch a bridge action. `params` is the raw request body (minus `action`).
 *
 *   listTabs                          → { fidelity, connected, tabs }
 *   presence                          → { fidelity, connected, tabCount, activeTab }
 *   focus/close/group/move (tabId)    → a confirmation string (mutations ask per-origin consent)
 *   track (tabId)                     → flashes a tracking cursor, mutates nothing
 *   extract (tabId, maxChars?)        → { id, url, title, truncated, text } (separate content consent)
 */
export async function runBridgeAction(
  action: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<BridgeActionResult> {
  const hub = getBridgeHub();

  if (action === 'listTabs') {
    return {
      ok: true,
      data: { fidelity: hub.getFidelity(), connected: hub.isConnected(), tabs: hub.getTabs() },
    };
  }

  if (action === 'presence') {
    const active = hub.getActiveTab();
    return {
      ok: true,
      data: {
        fidelity: hub.getFidelity(),
        connected: hub.isConnected(),
        tabCount: hub.getTabs().length,
        activeTab: active ? { id: active.id, title: active.title, url: active.url } : null,
      },
    };
  }

  if (!TAB_ACTIONS.includes(action as TabAction)) {
    return {
      ok: false,
      error: `Unknown action "${action}". Use one of: listTabs, presence, ${TAB_ACTIONS.join(', ')}.`,
      status: 400,
    };
  }

  const tabId = typeof params.tabId === 'number' ? params.tabId : Number(params.tabId);
  if (!Number.isFinite(tabId)) {
    return {
      ok: false,
      error: 'A numeric "tabId" is required. Call listTabs to get tab ids.',
      status: 400,
    };
  }

  const tab = hub.getTab(tabId);
  if (!tab) {
    return {
      ok: false,
      error: `No tab with id ${tabId}. It may have been closed — re-list tabs.`,
      status: 404,
    };
  }

  // 'track' — a pure observation cue: light up YAAR's presence on the tab, mutate nothing.
  if (action === 'track') {
    hub.sendActivity({ kind: 'observe', tabId, action, label: activityLabel(action, tab) });
    return { ok: true, data: `Showing a tracking cursor on "${tabName(tab)}".` };
  }

  // 'extract' (T3-lite) — return the tab's page text. Not a mutation, but it crosses the
  // tab-metadata boundary, so it has its OWN per-origin consent (distinct from tab control).
  if (action === 'extract') {
    const guard = await enforceContentReadGuard({ tab, sessionId });
    if (!guard.ok) return { ok: false, error: guard.error, status: 403 };

    hub.sendActivity({ kind: 'observe', tabId, action, label: activityLabel(action, tab) });

    const maxChars =
      typeof params.maxChars === 'number' ? params.maxChars : BRIDGE_CONTENT_MAX_CHARS;
    const outcome = await hub.sendCommand({ action: 'extract', tabId, maxChars });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const content = (outcome.data ?? {}) as {
      url?: string;
      title?: string;
      text?: string;
      truncated?: boolean;
    };
    return {
      ok: true,
      data: {
        id: tabId,
        url: content.url ?? tab.url,
        title: content.title ?? tab.title,
        truncated: !!content.truncated,
        text: content.text ?? '',
      },
    };
  }

  // focus / close / group / move — consent + self-target guard (focus is free; the rest are gated).
  const guard = await enforceTabControlGuard({ tab, action, sessionId });
  if (!guard.ok) return { ok: false, error: guard.error, status: 403 };

  hub.sendActivity({ kind: 'act', tabId, action, label: activityLabel(action, tab) });

  const cmd: Parameters<typeof hub.sendCommand>[0] = {
    action: action as Exclude<TabAction, 'track'>,
    tabId,
  };
  if (action === 'group') {
    const extra = Array.isArray(params.tabIds)
      ? (params.tabIds as unknown[]).filter((n): n is number => typeof n === 'number')
      : [];
    cmd.tabIds = [tabId, ...extra.filter((n) => n !== tabId)];
    if (typeof params.groupTitle === 'string') cmd.groupTitle = params.groupTitle;
  } else if (action === 'move') {
    if (typeof params.index === 'number') cmd.index = params.index;
    if (typeof params.windowId === 'number') cmd.windowId = params.windowId;
  }

  const outcome = await hub.sendCommand(cmd);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return { ok: true, data: `${action} → "${tabName(tab)}" (tab ${tabId}) ✓` };
}
