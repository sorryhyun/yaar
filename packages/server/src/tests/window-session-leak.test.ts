/**
 * A window the user closed stays closed — across a restore, and in the registry.
 *
 * These pin one bug with three faces, all from a single split: a window the *user*
 * opened was recorded with a bare id (`window.create "process-explorer"`) while every
 * interaction on it was recorded with the monitor-scoped handle (`close:0/process-explorer`).
 *
 *   1. The restore reader compared the two as written, so the close cancelled nothing and
 *      every hand-opened window came back on the next launch.
 *   2. Replayed bare, the window sat in the registry under a key on no monitor — listed to
 *      every monitor's agent, since an unscoped window is listed on all of them.
 *   3. Every close of it re-derived a *scoped* key, deleted that (empty) key, and reported
 *      success. So neither the process-explorer's `delete` nor the user's own close button
 *      could ever remove it, and the agents kept addressing a window that was off screen.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction, UserInteraction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import { getWindowRestoreActions } from '../logging/window-restore.js';
import type { ParsedMessage } from '../logging/types.js';

const noAppMeta = async () => null;

function createInteraction(windowId: string, monitorId?: string): UserInteraction {
  return {
    type: 'window.create',
    timestamp: 1,
    windowId,
    monitorId,
    windowTitle: windowId,
    bounds: { x: 0, y: 0, w: 640, h: 480 },
    content: { renderer: 'iframe', data: `yaar://apps/${windowId}` },
    appId: windowId,
  } as UserInteraction;
}

/** The transcript shape the bug was found in — see session_logs/2026-08-02_18-49-25. */
function transcript(entries: Array<OSAction | string>): ParsedMessage[] {
  return entries.map((entry) =>
    typeof entry === 'string'
      ? ({ type: 'interaction', interaction: entry } as ParsedMessage)
      : ({ type: 'action', action: entry } as ParsedMessage),
  );
}

describe('user-opened windows are recorded by handle', () => {
  it('logs the scoped handle for a window the user opened, not the raw id', async () => {
    const registry = new WindowStateRegistry();

    const applied = await registry.applyUserInteraction(
      createInteraction('process-explorer', '0'),
      noAppMeta,
    );

    // This action is what the session logger writes, and what the next launch restores.
    expect(applied).toHaveLength(1);
    expect((applied[0] as { windowId: string }).windowId).toBe('0/process-explorer');
    expect(registry.listWindows('0').map((w) => w.id)).toEqual(['0/process-explorer']);
  });

  it('places a hand-opened window on the monitor the user was watching', async () => {
    const registry = new WindowStateRegistry();

    const applied = await registry.applyUserInteraction(createInteraction('memo', '1'), noAppMeta);

    expect((applied[0] as { windowId: string }).windowId).toBe('1/memo');
    expect(registry.listWindows('0')).toHaveLength(0);
    expect(registry.listWindows('1')).toHaveLength(1);
  });

  it("closes the window the user closed, so it leaves the agents' view", async () => {
    const registry = new WindowStateRegistry();
    await registry.applyUserInteraction(createInteraction('process-explorer', '0'), noAppMeta);

    // The frontend addresses windows by their scoped key, which is what comes back here.
    await registry.applyUserInteraction(
      {
        type: 'window.close',
        timestamp: 2,
        windowId: '0/process-explorer',
        monitorId: '0',
      } as UserInteraction,
      noAppMeta,
    );

    expect(registry.listWindows()).toHaveLength(0);
    expect(registry.hasWindow('process-explorer')).toBe(false);
  });
});

describe('getWindowRestoreActions', () => {
  it('does not restore a hand-opened window the user closed', () => {
    // Exactly the sequence in the reported transcript: a bare create, a scoped close.
    const messages = transcript([
      { ...(createInteraction('process-explorer') as unknown as OSAction) },
      'close:0/process-explorer',
    ]);
    // Only the action rows matter for the create; rewrite the first as a real action.
    messages[0] = {
      type: 'action',
      action: {
        type: 'window.create',
        windowId: 'process-explorer',
        title: 'Process Explorer',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'iframe', data: 'yaar://apps/process-explorer' },
      } as OSAction,
    } as ParsedMessage;

    expect(getWindowRestoreActions(messages)).toEqual([]);
  });

  it('scopes a bare restored id so the window lands on a monitor', () => {
    const actions = getWindowRestoreActions(
      transcript([
        {
          type: 'window.create',
          windowId: 'lab',
          title: 'Lab',
          bounds: { x: 0, y: 0, w: 640, h: 480 },
          content: { renderer: 'markdown', data: 'x' },
        } as OSAction,
      ]),
    );

    expect(actions).toHaveLength(1);
    expect((actions[0] as { windowId: string }).windowId).toBe('0/lab');
  });

  it('still cancels a create whose close was recorded in the same spelling', () => {
    expect(
      getWindowRestoreActions(
        transcript([
          {
            type: 'window.create',
            windowId: '0/github',
            title: 'GitHub',
            bounds: { x: 0, y: 0, w: 640, h: 480 },
            content: { renderer: 'markdown', data: 'x' },
          } as OSAction,
          'close:0/github',
        ]),
      ),
    ).toEqual([]);
  });
});

describe('restored windows stay closable', () => {
  it('closes a restored window addressed by its raw id', () => {
    const registry = new WindowStateRegistry();
    registry.restoreFromActions([
      {
        type: 'window.create',
        windowId: '0/process-explorer',
        title: 'Process Explorer',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'iframe', data: 'yaar://apps/process-explorer' },
        appId: 'process-explorer',
      } as OSAction,
    ]);

    expect(registry.hasWindow('process-explorer')).toBe(true);

    // What `delete("yaar://windows/process-explorer")` from the process-explorer app
    // amounts to: a close carrying the raw id and the caller's monitor.
    registry.handleAction({ type: 'window.close', windowId: 'process-explorer' } as OSAction, '0');

    expect(registry.listWindows()).toHaveLength(0);
  });

  it('closes a window that landed under a bare, monitor-less key', () => {
    // `getWindowRestoreActions` no longer produces one of these, but the registry must
    // not depend on that: a bare key was unclosable *forever*, because every close
    // minted a scoped key, deleted nothing under it, and reported success.
    const registry = new WindowStateRegistry();
    registry.handleAction({
      type: 'window.create',
      windowId: 'process-explorer',
      title: 'Process Explorer',
      bounds: { x: 0, y: 0, w: 640, h: 480 },
      content: { renderer: 'iframe', data: 'yaar://apps/process-explorer' },
      appId: 'process-explorer',
    } as OSAction);

    expect(registry.listWindows('0')).toHaveLength(1);

    registry.handleAction({ type: 'window.close', windowId: 'process-explorer' } as OSAction, '0');

    expect(registry.listWindows()).toHaveLength(0);
  });

  it('closes a restored window addressed by its handle', () => {
    const registry = new WindowStateRegistry();
    registry.restoreFromActions([
      {
        type: 'window.create',
        windowId: '0/memo',
        title: 'Memo',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'markdown', data: 'x' },
      } as OSAction,
    ]);

    registry.handleAction({ type: 'window.close', windowId: '0/memo' } as OSAction, '0');

    expect(registry.listWindows()).toHaveLength(0);
  });

  it('reports the closed window to the close callback under its real key', () => {
    const registry = new WindowStateRegistry();
    const closed: Array<[string, string | undefined, string | undefined]> = [];
    registry.setOnWindowClose((windowId, appId, monitorId) =>
      closed.push([windowId, appId, monitorId]),
    );
    registry.restoreFromActions([
      {
        type: 'window.create',
        windowId: '0/devtools',
        title: 'Devtools',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'iframe', data: 'yaar://apps/devtools' },
        appId: 'devtools',
      } as OSAction,
    ]);

    registry.handleAction({ type: 'window.close', windowId: 'devtools' } as OSAction, '0');

    // The appId is what finds the app agent driving this window — read from the window
    // that actually closed, not from a key minted on the way past it.
    expect(closed).toEqual([['0/devtools', 'devtools', '0']]);
  });

  it('does not resolve a close onto another monitor’s copy of the same app', () => {
    const registry = new WindowStateRegistry();
    registry.restoreFromActions([
      {
        type: 'window.create',
        windowId: '0/memo',
        title: 'Memo',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'markdown', data: 'a' },
      } as OSAction,
      {
        type: 'window.create',
        windowId: '1/memo',
        title: 'Memo',
        bounds: { x: 0, y: 0, w: 640, h: 480 },
        content: { renderer: 'markdown', data: 'b' },
      } as OSAction,
    ]);

    registry.handleAction({ type: 'window.close', windowId: 'memo' } as OSAction, '1');

    expect(registry.listWindows().map((w) => w.id)).toEqual(['0/memo']);
  });
});
