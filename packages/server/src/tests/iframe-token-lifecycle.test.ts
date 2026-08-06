/**
 * An iframe token is a credential, and a window is what it is a credential *for*.
 *
 * Two halves of that sentence are pinned here:
 *
 * - **Several live tokens per window is the design, not the bug.** Every reconnect mints a
 *   fresh token per open iframe window, per connection (`SessionSnapshotService` →
 *   `refreshRestoredWindowActions`), and two tabs on one session both hold a working one.
 *   A re-mint deliberately does not revoke its predecessor: the other tab is still showing
 *   that window. These tests are what stops a revocation fix from "correcting" multi-tab
 *   away.
 *
 * - **None of them may outlive the window.** There used to be no revocation at all — the
 *   one helper that could do it had zero callers, and the close teardown
 *   (`WindowStateRegistry` → `WindowEventCoordinator`) cleared delegated
 *   grants, app commands, subscriptions, the context tape and the app agent — everything
 *   but the token. So a closed window's token stayed a valid credential, with the same
 *   appId and the same baked-in permissions, for up to the 24h TTL. App retire on redeploy
 *   (`features/apps/retire.ts`) goes through that same close pipeline and inherited the
 *   gap. `revokeTokensForWindow`, wired into `LiveSession`'s close callback, closes both.
 *
 * The close is driven through `actionEmitter` rather than poked into the registry, because
 * that is the one chokepoint every close funnels through — an agent's `window.close`, a
 * user closing a window, and a deploy retiring stale ones alike. Note what these sessions
 * are: attached but never pool-initialized. A revocation wired somewhere only a pooled
 * session reaches would leave this file red, which is exactly why the teardown is
 * registered in `LiveSession`'s constructor — windows outlive pool init (restore and
 * `POST /api/iframe-token` both mint against sessions that have no pool).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { validateIframeToken } from '../http/iframe-tokens.js';
import { handleCreate } from '../features/window/create.js';
import { retireStaleApp } from '../features/apps/retire.js';
import { actionEmitter } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import type { LiveSession } from '../session/live-session.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'ses-token-life' as SessionId;
const APP = 'memo';
const RAW_ID = 'memo';
/** What the registry keys the window by once it is registered on monitor 0. */
const HANDLE = '0/memo';

/** Answer the render handshake so `handleCreate` returns without waiting out its deadline. */
function watchActions(): { actions: OSAction[]; stop: () => void } {
  const actions: OSAction[] = [];
  const onAction = (event: { action: OSAction; requestId?: string }) => {
    actions.push(event.action);
    if (event.requestId) {
      actionEmitter.resolveFeedback({
        requestId: event.requestId,
        windowId: (event.action as { windowId?: string }).windowId ?? '',
        renderer: 'iframe',
        success: true,
      });
    }
  };
  actionEmitter.on('action', onAction);
  return { actions, stop: () => void actionEmitter.off('action', onAction) };
}

function asMonitorAgent<T>(fn: () => T): T {
  return runWithAgentContext(
    { agentId: 'monitor-0', role: 'monitor', sessionId: SESSION, monitorId: '0' },
    fn,
  );
}

/** Open the app window for real, and return the token minted at create time. */
async function openAppWindow(): Promise<string> {
  const watch = watchActions();
  try {
    await asMonitorAgent(() =>
      handleCreate(RAW_ID, {
        title: 'Memo',
        renderer: 'iframe',
        content: `/api/apps/${APP}/dist/index.html`,
        appId: APP,
      }),
    );
  } finally {
    watch.stop();
  }
  const create = watch.actions.find((a) => a.type === 'window.create') as
    | (OSAction & { iframeToken?: string })
    | undefined;
  if (typeof create?.iframeToken !== 'string') throw new Error('no token on the create action');
  return create.iframeToken;
}

/** The token one reconnecting tab is handed for the windows already open. */
async function reconnectToken(session: LiveSession): Promise<string> {
  const actions = (await session.generateSnapshot()) as Array<
    OSAction & { appId?: string; iframeToken?: string }
  >;
  const win = actions.find((a) => a.type === 'window.create' && a.appId === APP);
  if (typeof win?.iframeToken !== 'string') throw new Error('no token in the reconnect snapshot');
  return win.iframeToken;
}

function closeWindow(windowId: string): void {
  asMonitorAgent(() =>
    actionEmitter.emitAction(
      { type: 'window.close', windowId } as OSAction,
      SESSION,
      undefined,
      '0',
    ),
  );
}

function openSession(): LiveSession {
  return getSessionHub().attach(SESSION, {}).session;
}

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

describe('one window, several live tokens', () => {
  it('mints a token per reconnect without revoking the ones already out', async () => {
    const session = openSession();
    const minted = await openAppWindow();
    // Two tabs resyncing against the same session, each handed its own token.
    const tabA = await reconnectToken(session);
    const tabB = await reconnectToken(session);

    expect(new Set([minted, tabA, tabB]).size).toBe(3);
    for (const token of [minted, tabA, tabB]) {
      expect(validateIframeToken(token)).not.toBeNull();
    }
  });

  it('spells the same window two ways — raw at create, scoped at reconnect', async () => {
    const session = openSession();
    const minted = await openAppWindow();
    const refreshed = await reconnectToken(session);

    // Both spellings address one window; a revocation that knows only one of them leaves
    // the other live. `window-state.ts` deletes delegated grants under both for this reason.
    expect(validateIframeToken(minted)?.windowId).toBe(RAW_ID);
    expect(validateIframeToken(refreshed)?.windowId).toBe(HANDLE);
    expect(session.windowState.getWindow(RAW_ID)?.id).toBe(HANDLE);
  });
});

describe('a token dies with its window', () => {
  it('is valid for as long as the window is open', async () => {
    const session = openSession();
    const minted = await openAppWindow();
    const refreshed = await reconnectToken(session);

    expect(validateIframeToken(minted)).not.toBeNull();
    expect(validateIframeToken(refreshed)).not.toBeNull();
  });

  it('closing the window revokes the token minted at create', async () => {
    openSession();
    const minted = await openAppWindow();

    closeWindow(RAW_ID);

    expect(validateIframeToken(minted)).toBeNull();
  });

  it('closing the window revokes the token minted on reconnect', async () => {
    const session = openSession();
    await openAppWindow();
    const refreshed = await reconnectToken(session);

    closeWindow(RAW_ID);

    expect(validateIframeToken(refreshed)).toBeNull();
  });

  it('one close revokes every token out for that window', async () => {
    const session = openSession();
    const minted = await openAppWindow();
    const tabA = await reconnectToken(session);
    const tabB = await reconnectToken(session);

    closeWindow(RAW_ID);

    expect([minted, tabA, tabB].map(validateIframeToken)).toEqual([null, null, null]);
  });

  it('the window really is gone — the close landed', async () => {
    const session = openSession();
    await openAppWindow();
    expect(session.windowState.getWindow(RAW_ID)).toBeDefined();

    closeWindow(RAW_ID);

    expect(session.windowState.getWindow(RAW_ID)).toBeUndefined();
  });

  it('retiring an app’s stale windows revokes their tokens too', async () => {
    // A deploy closes what is still running the previous build (`features/apps/retire.ts`).
    // It goes through the same close pipeline, so it inherits whatever that pipeline does —
    // which today is nothing, leaving the replaced build's credential live.
    const session = openSession();
    const minted = await openAppWindow();
    const refreshed = await reconnectToken(session);

    const closed = runWithAgentContext(
      { agentId: 'iframe:devtools', sessionId: SESSION, monitorId: '0', appId: 'devtools' },
      () => retireStaleApp(APP),
    );
    expect(closed).toEqual([HANDLE]);

    expect(validateIframeToken(minted)).toBeNull();
    expect(validateIframeToken(refreshed)).toBeNull();
  });
});
