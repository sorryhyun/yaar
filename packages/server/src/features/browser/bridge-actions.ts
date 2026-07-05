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
import {
  enforceTabControlGuard,
  enforceContentReadGuard,
  grantTabUse,
  isTabUseAllowed,
} from './guards.js';

/** Tab-targeted actions. `focus/close/group/move` manage a tab; `track` is a cosmetic cue;
 *  `extract`/`screenshot` read the tab (separately consent-gated); `click/type/scroll/navigate`
 *  drive the page (tab-control consent-gated). */
const TAB_ACTIONS = [
  'focus',
  'close',
  'group',
  'move',
  'track',
  'extract',
  'click',
  'type',
  'scroll',
  'navigate',
  'screenshot',
] as const;
type TabAction = (typeof TAB_ACTIONS)[number];

/** Tab-targeted actions that need a `tabId` + tab lookup but aren't extension commands.
 *  `allow` is a user-only consent grant (the "Allow use" button), handled entirely server-side. */
const EXTRA_TAB_ACTIONS = ['allow'] as const;

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
  const VERBS: Record<string, string> = {
    track: 'watching',
    extract: 'reading',
    screenshot: 'viewing',
    allow: 'enabling',
    click: 'clicking',
    type: 'typing',
    scroll: 'scrolling',
    navigate: 'navigating',
  };
  return `YAAR · ${VERBS[action] ?? action} · ${tabName(t)}`;
}

/**
 * Dispatch a bridge action. `params` is the raw request body (minus `action`).
 *
 *   listTabs                             → { fidelity, connected, tabs }
 *   presence                             → { fidelity, connected, tabCount, activeTab }
 *   focus/close/group/move (tabId)       → a confirmation string (mutations ask per-origin consent)
 *   track (tabId)                        → flashes a tracking cursor, mutates nothing
 *   allow (tabId)                        → grants full agent use of the tab's origin (user consent act)
 *   extract (tabId, maxChars?)           → { id, url, title, truncated, text } (separate content consent)
 *   screenshot (tabId)                   → { dataUrl } PNG of the visible tab (content consent; tab must be focused)
 *   click (tabId, selector)              → drive: synthesize a click (tab-control consent)
 *   type (tabId, selector, text, submit?)→ drive: enter text, optionally submit (tab-control consent)
 *   scroll (tabId, selector?|deltaY?|top?)→ drive: scroll the page (tab-control consent)
 *   navigate (tabId, url)                → drive: load a URL in the tab (tab-control consent)
 */
export async function runBridgeAction(
  action: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<BridgeActionResult> {
  const hub = getBridgeHub();

  if (action === 'listTabs') {
    // Annotate each tab with whether the agent is already fully granted to use it, so the app can
    // show an "in use" badge and hide the tab's "Allow use" button.
    const tabs = await Promise.all(
      hub.getTabs().map(async (t) => ({ ...t, allowed: await isTabUseAllowed(t.url) })),
    );
    return {
      ok: true,
      data: { fidelity: hub.getFidelity(), connected: hub.isConnected(), tabs },
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

  const isTabTargeted =
    TAB_ACTIONS.includes(action as TabAction) ||
    (EXTRA_TAB_ACTIONS as readonly string[]).includes(action);
  if (!isTabTargeted) {
    return {
      ok: false,
      error: `Unknown action "${action}". Use one of: listTabs, presence, ${TAB_ACTIONS.join(', ')}, ${EXTRA_TAB_ACTIONS.join(', ')}.`,
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

  // 'allow' — the "Allow use" button: grant the agent full use (control + content read) of this
  // tab's origin up-front, so it can view, scroll, click, and read without further prompts. This is
  // a user consent act (the iframe posts it); the agent has no `allow` command of its own.
  if (action === 'allow') {
    if (tab.isSelf) {
      return {
        ok: false,
        error: "YAAR's own tab is always usable — no grant needed.",
        status: 400,
      };
    }
    const granted = await grantTabUse(tab.url);
    if (!granted.ok) return { ok: false, error: granted.error, status: 400 };
    hub.sendActivity({ kind: 'observe', tabId, action, label: activityLabel(action, tab) });
    return {
      ok: true,
      data: `Agent can now use "${tabName(tab)}" — view, scroll, click, and read on ${granted.domain}.`,
    };
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

  // 'screenshot' (T3 view) — a PNG of the visible tab. Like `extract` it reveals page content, so
  // it shares the content-read consent (not tab-control). The extension requires the tab to be
  // focused (captureVisibleTab only grabs the active tab); it returns a clean error otherwise.
  if (action === 'screenshot') {
    const guard = await enforceContentReadGuard({ tab, sessionId });
    if (!guard.ok) return { ok: false, error: guard.error, status: 403 };

    hub.sendActivity({ kind: 'observe', tabId, action, label: activityLabel(action, tab) });

    const outcome = await hub.sendCommand({ action: 'screenshot', tabId });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const shot = (outcome.data ?? {}) as { dataUrl?: string };
    return {
      ok: true,
      data: { id: tabId, url: tab.url, title: tab.title, dataUrl: shot.dataUrl ?? '' },
    };
  }

  // focus / close / group / move / click / type / scroll / navigate — consent + self-target guard
  // (focus is free; the mutating drive/manage verbs are gated by per-origin tab-control consent).

  // Validate required drive params up-front, so we never prompt the user for consent on a call that
  // was malformed to begin with.
  if (action === 'navigate' && typeof params.url !== 'string') {
    return { ok: false, error: 'navigate requires a "url" string.', status: 400 };
  }
  if ((action === 'click' || action === 'type') && typeof params.selector !== 'string') {
    return { ok: false, error: `${action} requires a CSS "selector" string.`, status: 400 };
  }
  if (action === 'type' && typeof params.text !== 'string') {
    return { ok: false, error: 'type requires a "text" string.', status: 400 };
  }

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
  } else if (action === 'navigate') {
    if (typeof params.url === 'string') cmd.url = params.url;
  } else if (action === 'click') {
    if (typeof params.selector === 'string') cmd.selector = params.selector;
  } else if (action === 'type') {
    if (typeof params.selector === 'string') cmd.selector = params.selector;
    if (typeof params.text === 'string') cmd.text = params.text;
    if (typeof params.submit === 'boolean') cmd.submit = params.submit;
  } else if (action === 'scroll') {
    if (typeof params.selector === 'string') cmd.selector = params.selector;
    if (typeof params.deltaY === 'number') cmd.deltaY = params.deltaY;
    if (typeof params.top === 'number') cmd.top = params.top;
  }

  const outcome = await hub.sendCommand(cmd);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  // The drive verbs carry back useful detail (matched element text, resulting scrollY, loaded url);
  // surface it to the agent. The manage verbs keep their compact confirmation string.
  const isDrive =
    action === 'click' || action === 'type' || action === 'scroll' || action === 'navigate';
  if (isDrive && outcome.data && Object.keys(outcome.data).length > 0) {
    return { ok: true, data: { action, tabId, ...outcome.data } };
  }
  return { ok: true, data: `${action} → "${tabName(tab)}" (tab ${tabId}) ✓` };
}
