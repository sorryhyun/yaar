/**
 * A deploy retires what is still running the previous build.
 *
 * Deploying replaced the app's files and told nobody: the open window kept rendering the
 * bundle its iframe had already loaded, and the app agent kept answering from the manifest
 * its cached profile was built with. Both looked live. The window someone screenshots to
 * confirm a deploy worked was the one showing the code the deploy had just replaced.
 *
 * These pin the retirement itself (`features/apps/retire.ts`) rather than a full
 * `doDeploy`, which writes into apps/.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { getSessionHub } from '../session/session-hub.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { retireStaleApp } from '../features/apps/retire.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'retire-session' as SessionId;

function appWindow(appId: string): OSAction {
  return {
    type: 'window.create',
    windowId: appId,
    title: appId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
    appId,
  } as OSAction;
}

/** A session holding the given app windows, each on the named monitor. */
function sessionWith(windows: Array<{ appId: string; monitorId: string }>) {
  const session = getSessionHub().getOrCreate(SESSION, {});
  for (const { appId, monitorId } of windows) {
    session.windowState.handleAction(appWindow(appId), monitorId);
  }
  return session;
}

/**
 * Retire `appId` as the deploying iframe would, and collect the close actions emitted.
 * `callerWindowId` is the raw window id the deployer's own iframe token carries.
 */
function retireAs(
  appId: string,
  caller: { appId: string; windowId?: string; monitorId: string },
): { closed: string[]; staleWindow?: string; events: ActionEvent[] } {
  const events: ActionEvent[] = [];
  const off = actionEmitter.onAction((e) => events.push(e));
  try {
    const result = runWithAgentContext(
      {
        agentId: `iframe:${caller.appId}`,
        sessionId: SESSION,
        monitorId: caller.monitorId,
        windowId: caller.windowId,
        appId: caller.appId,
      },
      () => retireStaleApp(appId),
    );
    return { ...result, events };
  } finally {
    off();
  }
}

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

describe('retiring an app whose files just changed', () => {
  it('closes the windows still running the old build', () => {
    const session = sessionWith([{ appId: 'memo', monitorId: '0' }]);

    const { closed, events } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual(['0/memo']);
    const close = events.find((e) => e.action.type === 'window.close');
    expect(close).toBeDefined();
    expect((close?.action as { windowId?: string }).windowId).toBe('0/memo');
    // The registry follows the action, so a relaunch mints a fresh window rather than
    // resolving into the one that just closed.
    expect(session.windowState.hasWindow('0/memo')).toBe(false);
  });

  it('leaves other apps alone', () => {
    const session = sessionWith([
      { appId: 'memo', monitorId: '0' },
      { appId: 'notes', monitorId: '0' },
    ]);

    const { closed } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual(['0/memo']);
    expect(session.windowState.hasWindow('0/notes')).toBe(true);
  });

  it('closes a copy on a monitor the deployer is not on, stamped with that monitor', () => {
    // The close is addressed by the window's own monitor, read off the handle map. Stamped
    // with the deployer's instead, the two registries key the same window differently and
    // the frontend never closes it.
    sessionWith([{ appId: 'memo', monitorId: '1' }]);

    const { closed, events } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual(['1/memo']);
    expect(events.find((e) => e.action.type === 'window.close')?.monitorId).toBe('1');
  });

  it('spares the deployer’s own window when an app deploys itself', () => {
    // devtools deploying devtools is a standing workflow. Closing the window mid-request
    // kills the tool at the moment it succeeded, which reads as a crash, not a deploy.
    const session = sessionWith([
      { appId: 'devtools', monitorId: '0' },
      { appId: 'devtools', monitorId: '1' },
    ]);

    const { closed, staleWindow } = retireAs('devtools', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual(['1/devtools']);
    expect(session.windowState.hasWindow('0/devtools')).toBe(true);
    // Spared, and *named*. The window is still running the bundle the deploy replaced, so
    // anything verified against it is a false result — the deployer has to be told, or
    // every repo-level check reports a fix that is not the code executing.
    expect(staleWindow).toBe('0/devtools');
  });

  it('reports no stale window when the deployer is not inside one of the app’s windows', () => {
    // A monitor agent, or an app deploying some *other* app: nothing was spared, so
    // there is nothing running the old build and nothing to reload.
    sessionWith([{ appId: 'memo', monitorId: '0' }]);

    const { closed, staleWindow } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual(['0/memo']);
    expect(staleWindow).toBeUndefined();
  });

  it('addresses each copy by handle, never by raw id', () => {
    // Both registries key windows by handle, and the frontend resolves a bare raw id by
    // scanning for a `/{id}` suffix — which cannot tell two monitors' copies of one app
    // apart. Addressed raw, a close aimed at monitor 1 can land on monitor 0's window.
    sessionWith([
      { appId: 'memo', monitorId: '0' },
      { appId: 'memo', monitorId: '1' },
    ]);

    const { closed, events } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed.sort()).toEqual(['0/memo', '1/memo']);
    const targets = events
      .filter((e) => e.action.type === 'window.close')
      .map((e) => (e.action as { windowId: string }).windowId);
    expect(targets.sort()).toEqual(['0/memo', '1/memo']);
  });

  it('is a no-op when nothing of the app is open', () => {
    sessionWith([{ appId: 'notes', monitorId: '0' }]);

    const { closed, events } = retireAs('memo', {
      appId: 'devtools',
      windowId: 'devtools',
      monitorId: '0',
    });

    expect(closed).toEqual([]);
    expect(events.filter((e) => e.action.type === 'window.close')).toHaveLength(0);
  });
});
