/**
 * Browser domain handlers for the verb layer (T1 Observe — read-only).
 *
 * Surfaces the user's real browser tabs (via the YAAR Bridge extension) as a live, read-only feed:
 *
 *   read('yaar://browser')             → connection + fidelity overview
 *   read('yaar://browser/tabs')        → all open tabs (title/url/active/isSelf)
 *   list('yaar://browser/tabs')        → navigable links to each tab
 *   read('yaar://browser/tabs/{id}')   → a single tab
 *   read('yaar://browser/presence')    → { fidelity, connected, tabCount, activeTab }
 *
 * This tier is tab-metadata only — never page content. Mutation verbs (focus/close/group) and the
 * ExtensionBridgeBrowser provider arrive in Slice 2. Reads are available to monitor agents and to
 * apps that declare `yaar://browser/tabs` in `app.json` `permissions` (existing default-deny on the
 * app path). See `0607plan.md` and `docs/extension_bridge_proposal.md`.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJsonResource, okLinks, error } from './utils.js';
import { getBridgeHub, type BrowserTab } from '../features/browser/bridge.js';

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
      "Observe the user's real browser tabs via the YAAR Bridge extension (read-only). " +
      'Read for a connection overview; see yaar://browser/tabs for the live tab list.',
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
      "The user's open browser tabs, live (read-only). Read for the full list; read " +
      'yaar://browser/tabs/{id} for one tab. Requires the YAAR Bridge extension to be connected.',
    verbs: ['describe', 'read', 'list'],

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const hub = getBridgeHub();
      const id = tabIdFromUri(resolved.sourceUri);
      if (id !== null) {
        const tab = hub.getTab(id);
        if (!tab) return error(`No tab with id ${id}. It may have been closed.`);
        return okJsonResource(resolved.sourceUri, tab);
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
