/**
 * Browser domain handlers for the verb layer (T1 Observe + T2 Manage + T3-lite content read).
 *
 * Surfaces the user's real browser tabs (via the YAAR Bridge extension) as a live feed, and lets
 * an agent manage them like OS windows and read a page's text:
 *
 *   read('yaar://browser')                          → connection + fidelity overview
 *   read('yaar://browser/tabs')                     → all open tabs (title/url/active/isSelf)
 *   list('yaar://browser/tabs')                     → navigable links to each tab
 *   read('yaar://browser/tabs/{id}')                → a single tab's METADATA (+ a hint to extract)
 *   invoke('yaar://browser/tabs/{id}', {action})    → focus/close/group/move/track (T2), or
 *                                                     'extract' → the page's TEXT CONTENT (T3-lite)
 *   read('yaar://browser/presence')                 → { fidelity, connected, tabCount, activeTab }
 *
 * IMPORTANT: the `read` VERB returns only tab metadata; the page's actual content comes from the
 * `extract` ACTION (invoke), so the two never collide. T2 mutations route through
 * `enforceTabControlGuard` (per-origin consent + self-target refusal); `extract` routes through
 * `enforceContentReadGuard` (a distinct per-origin content grant). Both are transported over the
 * bridge socket by `BridgeHub.sendCommand`; a cursor/tracking overlay is pushed via `sendActivity`.
 * Reads/invokes are available to monitor agents and to apps that declare `yaar://browser/tabs/` in
 * `app.json` `permissions`. See `0607plan.md` and `docs/extension_bridge_proposal.md`.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJsonResource, okLinks, error } from './utils.js';
import { BRIDGE_CONTENT_MAX_CHARS } from '@yaar/shared';
import { getBridgeHub, type BrowserTab } from '../features/browser/bridge.js';
import { enforceTabControlGuard, enforceContentReadGuard } from '../features/browser/guards.js';

/**
 * The verbs `invoke('yaar://browser/tabs/{id}')` accepts. `focus/close/group/move` are T2 Manage;
 * `track` is a cosmetic cue; `extract` (T3-lite) returns the tab's page text, separately gated.
 * Note `extract`, not `read`: the `read` *verb* returns tab metadata, so the content *action*
 * must have a distinct name or the two collide and agents get metadata when they wanted content.
 */
const TAB_ACTIONS = ['focus', 'close', 'group', 'move', 'track', 'extract'] as const;
type TabAction = (typeof TAB_ACTIONS)[number];

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

/** Extract the numeric tab id from a `yaar://browser/tabs/{id}` URI, or null. */
function tabIdFromUri(uri: string): number | null {
  const m = uri.match(/^yaar:\/\/browser\/tabs\/([^/]+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

function tabLabel(t: BrowserTab): string {
  const title = t.title || t.url || `tab ${t.id}`;
  const marks = [t.active ? 'active' : null, t.isSelf ? 'self' : null].filter(Boolean).join(', ');
  return marks ? `${title} (${marks})` : title;
}

export function registerBrowserHandlers(registry: ResourceRegistry): void {
  // ── yaar://browser — overview of the real-browser feed ──
  registry.register('yaar://browser', {
    description:
      "Observe and manage the user's real browser tabs via the YAAR Bridge extension. " +
      'Read for a connection overview; see yaar://browser/tabs for the live tab list and the ' +
      'focus/close/group/move verbs.',
    verbs: ['describe', 'read', 'list'],

    async read(): Promise<VerbResult> {
      const hub = getBridgeHub();
      return okJsonResource('yaar://browser', {
        fidelity: hub.getFidelity(),
        connected: hub.isConnected(),
        connection: hub.getConnection(),
        tabCount: hub.getTabs().length,
        namespaces: ['yaar://browser/tabs', 'yaar://browser/presence'],
      });
    },

    async list(): Promise<VerbResult> {
      return okLinks([
        { uri: 'yaar://browser/tabs', description: 'Live list of the real browser tabs' },
        { uri: 'yaar://browser/presence', description: 'Presence summary (media/active tab)' },
      ]);
    },
  });

  // ── yaar://browser/tabs and yaar://browser/tabs/{id} ──
  // Registered as a prefix so the same handler serves both the collection
  // ("yaar://browser/tabs") and individual tabs ("yaar://browser/tabs/{id}").
  registry.register('yaar://browser/tabs/', {
    description:
      "The user's open browser tabs, live. Read for the full list; read yaar://browser/tabs/{id} " +
      'for one tab. Manage a tab with invoke(yaar://browser/tabs/{id}, { action }): ' +
      "focus/close/group/move the real tab, 'track' to flash a cursor on it, or 'extract' to get " +
      "the page's TEXT CONTENT. (Note: the plain read verb on this URI returns only tab metadata — " +
      "use invoke {action:'extract'} for the actual page content.) Mutating a logged-in tab asks " +
      'per-origin consent; extracting its content asks a separate content-read consent; ' +
      "YAAR's own tab can't be closed/moved. " +
      'Requires the YAAR Bridge extension to be connected.',
    verbs: ['describe', 'read', 'list', 'invoke'],
    invokeSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TAB_ACTIONS],
          description:
            'focus (bring the tab forward), close, group (with tabIds), move (to index), ' +
            "'track' (flash a cursor/tracking cue without changing anything), or 'extract' (return " +
            "the tab's page TEXT CONTENT — asks per-origin content consent).",
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'group: additional tab ids to group alongside this one.',
        },
        groupTitle: { type: 'string', description: 'group: optional label for the new group.' },
        index: { type: 'number', description: 'move: destination index within the window.' },
        windowId: { type: 'number', description: 'move: destination window id.' },
        maxChars: {
          type: 'number',
          description: `extract: cap on returned page text length (default ${BRIDGE_CONTENT_MAX_CHARS}).`,
        },
      },
      required: ['action'],
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const hub = getBridgeHub();
      const id = tabIdFromUri(resolved.sourceUri);
      if (id !== null) {
        const tab = hub.getTab(id);
        if (!tab) return error(`No tab with id ${id}. It may have been closed.`);
        // Nudge: this URI's `read` verb is metadata only. Point the agent at the content path
        // right where it looked, so "read the tab" doesn't dead-end at title/url.
        return okJsonResource(resolved.sourceUri, {
          ...tab,
          hint: `This is tab metadata only. To read the page's actual text content, call invoke('${resolved.sourceUri}', { action: 'extract' }).`,
        });
      }
      if (!hub.isConnected()) {
        return ok(
          'YAAR Bridge is not connected — no real browser tabs available. ' +
            'Install/enable the extension (see extension/README.md).',
        );
      }
      return okJsonResource('yaar://browser/tabs', {
        fidelity: hub.getFidelity(),
        tabs: hub.getTabs(),
      });
    },

    async list(): Promise<VerbResult> {
      const hub = getBridgeHub();
      return okLinks(
        hub.getTabs().map((t) => ({
          uri: `yaar://browser/tabs/${t.id}`,
          name: tabLabel(t),
          description: t.url,
        })),
      );
    },

    // ── T2 Manage: focus/close/group/move a real tab, or flash a tracking cursor. ──
    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const hub = getBridgeHub();
      const id = tabIdFromUri(resolved.sourceUri);
      if (id === null) {
        return error(
          'Target a specific tab: invoke("yaar://browser/tabs/{id}", { action }). ' +
            'List tabs with list("yaar://browser/tabs") to get ids.',
        );
      }
      const tab = hub.getTab(id);
      if (!tab)
        return error(`No tab with id ${id}. It may have been closed — re-read the tab list.`);

      const action = String(payload?.action ?? '');
      if (!TAB_ACTIONS.includes(action as TabAction)) {
        return error(`Unknown action "${action}". Use one of: ${TAB_ACTIONS.join(', ')}.`);
      }

      // 'track' — a pure observation cue: light up YAAR's presence on the tab, mutate nothing.
      if (action === 'track') {
        hub.sendActivity({ kind: 'observe', tabId: id, action, label: activityLabel(action, tab) });
        return ok(`Showing a tracking cursor on "${tabName(tab)}".`);
      }

      // 'extract' (T3-lite) — return the tab's page text. Not a mutation, but it crosses the
      // tab-metadata boundary, so it has its OWN per-origin consent (distinct from tab control).
      if (action === 'extract') {
        const { getSessionId } = await import('../agents/agent-context.js');
        const guard = await enforceContentReadGuard({ tab, sessionId: getSessionId() });
        if (!guard.ok) return error(guard.error);

        // An 'observe' cue (blue) — YAAR is watching/reading, not acting on, the tab.
        hub.sendActivity({ kind: 'observe', tabId: id, action, label: activityLabel(action, tab) });

        const maxChars =
          typeof payload?.maxChars === 'number' ? payload.maxChars : BRIDGE_CONTENT_MAX_CHARS;
        const outcome = await hub.sendCommand({ action: 'extract', tabId: id, maxChars });
        if (!outcome.ok) return error(outcome.error);
        const content = (outcome.data ?? {}) as {
          url?: string;
          title?: string;
          text?: string;
          truncated?: boolean;
        };
        return okJsonResource(resolved.sourceUri, {
          id,
          url: content.url ?? tab.url,
          title: content.title ?? tab.title,
          truncated: !!content.truncated,
          text: content.text ?? '',
        });
      }

      // Consent + self-target guard (per-origin grant for close/group/move; focus is free).
      // agent-context is imported lazily: pulling its AsyncLocalStorage getters into this handler's
      // eager module graph mis-links `getAgentRole` under Bun's loader (same cycle the uri-registry
      // resolver injection sidesteps). Deferring to call-time keeps the graph acyclic.
      const { getSessionId } = await import('../agents/agent-context.js');
      const guard = await enforceTabControlGuard({ tab, action, sessionId: getSessionId() });
      if (!guard.ok) return error(guard.error);

      // Paint the cursor/tracking overlay on the target tab as the command fires.
      hub.sendActivity({ kind: 'act', tabId: id, action, label: activityLabel(action, tab) });

      // 'track' returned above, so `action` is a real command verb here.
      const cmd: Parameters<typeof hub.sendCommand>[0] = {
        action: action as Exclude<TabAction, 'track'>,
        tabId: id,
      };
      if (action === 'group') {
        const extra = Array.isArray(payload?.tabIds)
          ? (payload!.tabIds as unknown[]).filter((n): n is number => typeof n === 'number')
          : [];
        cmd.tabIds = [id, ...extra.filter((n) => n !== id)];
        if (typeof payload?.groupTitle === 'string') cmd.groupTitle = payload.groupTitle;
      } else if (action === 'move') {
        if (typeof payload?.index === 'number') cmd.index = payload.index;
        if (typeof payload?.windowId === 'number') cmd.windowId = payload.windowId;
      }

      const outcome = await hub.sendCommand(cmd);
      if (!outcome.ok) return error(outcome.error);
      return ok(`${action} → "${tabName(tab)}" (tab ${id}) ✓`);
    },
  });

  // ── yaar://browser/presence — shared surface with the OS-presence floor ──
  registry.register('yaar://browser/presence', {
    description:
      "A read-only summary of the user's browser presence (active tab, tab count, fidelity). " +
      'When the Bridge is connected this is fidelity:"bridge"; otherwise fidelity:"os-signals".',
    verbs: ['describe', 'read'],

    async read(): Promise<VerbResult> {
      const hub = getBridgeHub();
      const active = hub.getActiveTab();
      return okJsonResource('yaar://browser/presence', {
        fidelity: hub.getFidelity(),
        connected: hub.isConnected(),
        tabCount: hub.getTabs().length,
        activeTab: active ? { id: active.id, title: active.title, url: active.url } : null,
      });
    },
  });
}
