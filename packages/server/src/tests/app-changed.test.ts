/**
 * `notifyAppChanged` — the one follow-up to an app's files changing on disk.
 *
 * Deploy, install, uninstall and restore each used to run their own subset of it, so
 * the behaviour a user saw depended on which door changed the app. These pin the whole
 * sequence once, from the outside: what reaches the session, in what order, and what
 * the caller's one choice (`retire`) changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { OSAction } from '@yaar/shared';
import { getSessionHub } from '../session/session-hub.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { notifyAppChanged } from '../features/apps/changed.js';
import { readManifest } from '../features/apps/manifest.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';
import { readShortcuts, removeAppShortcut } from '../storage/shortcuts.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'app-changed-session' as SessionId;
const OTHER = 'app-changed-other' as SessionId;
const APP_ID = 'app-changed-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

function writeApp(meta: Record<string, unknown>): void {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(meta));
}

function openWindow(sessionId: SessionId): void {
  getSessionHub()
    .getOrCreate(sessionId, {})
    .windowState.handleAction(
      {
        type: 'window.create',
        windowId: APP_ID,
        title: APP_ID,
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'iframe', data: `yaar://apps/${APP_ID}` },
        appId: APP_ID,
      } as OSAction,
      '0',
    );
}

/** Run as a monitor agent of SESSION would, and collect everything sent to the desktop. */
async function notifyAs(retire: boolean) {
  const desktop: OSAction[] = [];
  const closes: ActionEvent[] = [];
  const onDesktop = (e: SessionScopedEvent) => {
    if (e.sessionId === SESSION && 'actions' in e.event) desktop.push(...e.event.actions);
  };
  actionEmitter.on('desktop-shortcut', onDesktop);
  const off = actionEmitter.onAction((e) => {
    if (e.action.type === 'window.close') closes.push(e);
  });
  try {
    const result = await runWithAgentContext(
      { agentId: 'monitor-0', sessionId: SESSION, monitorId: '0' },
      () => notifyAppChanged(APP_ID, { retire }),
    );
    return { result, desktop, closes };
  } finally {
    actionEmitter.off('desktop-shortcut', onDesktop);
    off();
  }
}

beforeEach(async () => {
  rmSync(appDir, { recursive: true, force: true });
  await removeAppShortcut(APP_ID);
});

afterEach(async () => {
  rmSync(appDir, { recursive: true, force: true });
  await removeAppShortcut(APP_ID);
  await getSessionHub().remove(SESSION);
  await getSessionHub().remove(OTHER);
});

describe('an app whose files changed', () => {
  it('gets a shortcut once, announced once, and a refresh last', async () => {
    writeApp({ name: 'Changed Fixture', icon: '🧪' });

    const first = await notifyAs(false);
    expect(first.desktop.map((a) => a.type)).toEqual([
      'desktop.createShortcut',
      'desktop.refreshApps',
    ]);
    const stored = (await readShortcuts()).filter((s) => s.id === `app-${APP_ID}`);
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe('Changed Fixture');

    // Already there: the frontend appends a createShortcut, so a second one would be a
    // second icon.
    const second = await notifyAs(false);
    expect(second.desktop.map((a) => a.type)).toEqual(['desktop.refreshApps']);
  });

  it('loses its shortcut once it no longer wants one, or is gone', async () => {
    writeApp({ name: 'Changed Fixture' });
    await notifyAs(false);

    writeApp({ name: 'Changed Fixture', createShortcut: false });
    const optedOut = await notifyAs(false);
    expect(optedOut.desktop.map((a) => a.type)).toEqual([
      'desktop.removeShortcut',
      'desktop.refreshApps',
    ]);

    writeApp({ name: 'Changed Fixture' });
    await notifyAs(false);
    rmSync(appDir, { recursive: true, force: true });
    const removed = await notifyAs(false);
    expect(removed.desktop.map((a) => a.type)).toEqual([
      'desktop.removeShortcut',
      'desktop.refreshApps',
    ]);
    expect((await readShortcuts()).some((s) => s.id === `app-${APP_ID}`)).toBe(false);
  });

  it('closes running windows only when asked to retire them', async () => {
    writeApp({ name: 'Changed Fixture' });
    openWindow(SESSION);

    const kept = await notifyAs(false);
    expect(kept.result.closed).toEqual([]);
    expect(kept.closes).toHaveLength(0);

    const retired = await notifyAs(true);
    expect(retired.result.closed).toEqual([`0/${APP_ID}`]);
    expect(retired.closes).toHaveLength(1);
  });

  it('drops the cached agent profile in every session, not just the caller’s', async () => {
    writeApp({ name: 'Changed Fixture' });
    const invalidated: string[] = [];
    for (const id of [SESSION, OTHER]) {
      const session = getSessionHub().getOrCreate(id, {});
      // The pool is created on a session's first message; stand one in for the cache.
      session.getPool = (() => ({
        invalidateAppProfile: (appId: string) => invalidated.push(`${id}:${appId}`),
      })) as unknown as typeof session.getPool;
    }

    await notifyAs(false);

    expect(invalidated.sort()).toEqual([`${OTHER}:${APP_ID}`, `${SESSION}:${APP_ID}`].sort());
  });

  it('drops the cached manifest, so a same-stamp rewrite is seen', async () => {
    writeApp({ name: 'One' });
    const then = new Date(Date.now() - 60_000);
    utimesSync(join(appDir, 'app.json'), then, then);
    expect((await readManifest(appDir))?.name).toBe('One');

    writeApp({ name: 'Two' });
    utimesSync(join(appDir, 'app.json'), then, then);
    await notifyAs(false);

    expect((await readManifest(appDir))?.name).toBe('Two');
  });
});
