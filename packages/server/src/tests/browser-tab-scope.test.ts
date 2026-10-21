/**
 * Sandbox tabs are scoped per app (issue #187, item 4).
 *
 * A Dev Tools preview and the installed app built from the same source chose the same
 * `browserId`s, and every preview mount closed the installed copy's tab `'live'` — with
 * the user halfway through a Cloudflare check in it. Each app now addresses only its own
 * tabs, in its own terms; the Browser app, which shows any app's visible tab, still sees
 * the whole pool; and a preview's tabs go when its last window does.
 */
import { describe, it, expect } from 'bun:test';
import { popupBrowserId, tabScopeFor } from '../lib/browser/tab-scope.js';
import { closeAppTabs, runBrowserAction } from '../features/browser/actions.js';
import type { BrowserProvider, BrowserSession } from '../lib/browser/index.js';

const installed = tabScopeFor({ appId: 'agent-web' });
const preview = tabScopeFor({ appId: 'preview--1792382655833' });

describe('tabScopeFor', () => {
  it('gives two apps that chose the same id two different tabs', () => {
    expect(installed.toPool('live')).not.toBe(preview.toPool('live'));
  });

  it('round-trips an app id, and does not prefix one twice', () => {
    const pool = installed.toPool('live');
    expect(installed.toApp(pool)).toBe('live');
    expect(installed.toPool(pool)).toBe(pool);
  });

  it("does not let an app own another app's tab", () => {
    expect(installed.owns(preview.toPool('live'))).toBe(false);
    expect(installed.owns(installed.toPool('live'))).toBe(true);
    // Asked for by its stored id, it is a tab of this app's that does not exist.
    expect(installed.toPool(preview.toPool('live'))).not.toBe(preview.toPool('live'));
  });

  it('takes its own prefix out of outgoing text', () => {
    expect(installed.toAppText(`[browser:${installed.toPool('live')}] Created`)).toBe(
      '[browser:live] Created',
    );
  });

  it('leaves the bundled Browser app unscoped, and only the bundled one', () => {
    const viewer = tabScopeFor({ appId: 'browser', systemApp: true });
    expect(viewer.toPool('agent-web__live')).toBe('agent-web__live');
    expect(viewer.owns('agent-web__live')).toBe(true);
    expect(tabScopeFor({ appId: 'browser' }).toPool('x')).not.toBe('x');
  });

  it('puts a popup in its opener’s scope', () => {
    expect(popupBrowserId(installed.toPool('live'), 7)).toBe(installed.toPool('7'));
    expect(popupBrowserId('3', 7)).toBe('7');
    expect(popupBrowserId(undefined, 7)).toBe('7');
  });
});

/** A pool holding these tabs, recording what is closed. Only what the code under test reads. */
function fakePool(ids: string[]) {
  const live = new Map(ids.map((id) => [id, { currentUrl: `https://x/${id}` } as BrowserSession]));
  const closed: string[] = [];
  const pool = {
    getAllSessions: () => new Map(live),
    getSession: (id: string) => live.get(id),
    listSessionInfo: async () => [...live.keys()].map((id) => ({ id })),
    closeSession: async (id: string) => {
      closed.push(id);
      live.delete(id);
    },
  } as unknown as BrowserProvider;
  return { pool, closed };
}

describe('list_tabs', () => {
  it("lists only the caller's own tabs", async () => {
    const { pool } = fakePool([installed.toPool('live'), preview.toPool('live'), '0']);
    const result = await runBrowserAction(pool, 'list_tabs', '0', {}, installed);
    const tabs = JSON.parse((result.content[0] as { text: string }).text) as { id: string }[];
    expect(tabs.map((t) => t.id)).toEqual([installed.toPool('live')]);
  });
});

describe('closeAppTabs', () => {
  it("closes a preview's tabs and leaves the installed app's alone", async () => {
    const { pool, closed } = fakePool([installed.toPool('live'), preview.toPool('live')]);
    const n = await closeAppTabs(pool, 'preview--1792382655833', 'ses-1');
    expect(n).toBe(1);
    expect(closed).toEqual([preview.toPool('live')]);
  });
});
