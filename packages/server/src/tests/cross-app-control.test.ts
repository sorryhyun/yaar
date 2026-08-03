/**
 * Which window a controlled app is driven through — and when one gets opened.
 *
 * `controls` is authority over another app, and the app agent holding it has no window
 * verbs at all: `describe`/`query`/`command`/`relay` is its whole surface. So "the target
 * must already be open" would make the grant unusable for any app the user has not opened
 * by hand, which is why resolution ends in opening one. These pin the order it resolves in
 * (the app agent's most recent window → any window of that app on this monitor → a fresh
 * one), the monitor scoping, and the two callers' different authority to launch.
 *
 * The second case is the one that had two answers: cross-app control walked the pool *and*
 * the window list, while `direct_message` asked the pool alone — so a window the user
 * opened and never messaged was drivable and unmessageable at the same time.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { getSessionHub } from '../session/session-hub.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { resolveAppWindowOnMonitor } from '../features/window/resolve-app-window.js';
import type { LiveSession } from '../session/live-session.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'cross-app-session' as SessionId;

/** The app opened for real in the launch cases — bundled, so `listApps` finds it. */
const TARGET_APP = 'lab';

function windowAction(windowId: string, appId?: string): OSAction {
  return {
    type: 'window.create',
    windowId,
    title: windowId,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'iframe', data: `yaar://apps/${appId ?? windowId}` },
    ...(appId ? { appId } : {}),
  } as OSAction;
}

/** A session holding the given windows, each on the named monitor. */
function sessionWith(windows: Array<{ windowId: string; appId?: string; monitorId: string }>) {
  const session = getSessionHub().getOrCreate(SESSION, {});
  for (const { windowId, appId, monitorId } of windows) {
    session.windowState.handleAction(windowAction(windowId, appId), monitorId);
  }
  return session;
}

/**
 * Pretend the app agent has already acted on `windowId`.
 *
 * The real answer comes from `ContextPool.getActiveAppWindow`, which needs a live pool
 * and an app turn to have run; the resolver only ever asks it this one question.
 */
function withActiveAppWindow(session: LiveSession, answer: (appId: string) => string | undefined) {
  (session as unknown as { getPool: () => unknown }).getPool = () => ({
    getActiveAppWindow: (_monitorId: string, appId: string) => answer(appId),
  });
}

/** Resolve as an app agent running on `monitorId`. */
function resolveOn(
  session: LiveSession,
  monitorId: string,
  opts: { launch: boolean; background?: boolean } = { launch: true },
) {
  return runWithAgentContext({ agentId: 'app-agent-devtools', sessionId: SESSION, monitorId }, () =>
    resolveAppWindowOnMonitor(session, monitorId, TARGET_APP, opts),
  );
}

/**
 * Answer the create's render feedback the way a connected frontend would.
 *
 * Without it every launch case pays the full 2s iframe deadline and comes back
 * `renderConfirmed: false` — a slow test asserting on the degraded path.
 *
 * Scoped to this session because `actionEmitter` is process-global and the unit
 * partition runs files concurrently: an unscoped answerer settles *another* file's
 * pending create with a fabricated success, from a listener that test cannot see.
 */
function answerRenderFeedback(): () => void {
  return actionEmitter.onAction((e: ActionEvent) => {
    const action = e.action as OSAction & { windowId?: string };
    if (e.sessionId !== SESSION || action.type !== 'window.create' || !e.requestId) return;
    actionEmitter.resolveFeedback({
      requestId: e.requestId,
      windowId: action.windowId ?? '',
      renderer: 'iframe',
      success: true,
    });
  });
}

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

describe('resolving the window a controlled app is driven through', () => {
  it('prefers the window that app agent last acted on', async () => {
    const session = sessionWith([
      { windowId: 'lab', appId: TARGET_APP, monitorId: '0' },
      { windowId: 'lab-2', appId: TARGET_APP, monitorId: '0' },
    ]);
    withActiveAppWindow(session, (appId) => (appId === TARGET_APP ? 'lab-2' : undefined));

    const resolved = await resolveOn(session, '0');

    expect(resolved).toEqual({ found: true, windowId: 'lab-2', launched: false });
  });

  it('finds a window the pool never recorded — the one messaging used to miss', async () => {
    // The user opened it; no app turn has run, so the pool knows nothing about it.
    const session = sessionWith([{ windowId: 'lab', appId: TARGET_APP, monitorId: '0' }]);

    const resolved = await resolveOn(session, '0', { launch: false });

    // The registry lists windows by handle, so this branch answers `0/lab` where the
    // pool's answer is a raw id. Both address the same window — every consumer resolves
    // through `WindowStateRegistry`, which matches a handle exactly and a raw id against
    // the caller's monitor.
    expect(resolved).toEqual({ found: true, windowId: '0/lab', launched: false });
    expect(session.windowState.getWindow('0/lab')?.appId).toBe(TARGET_APP);
  });

  it('never reaches across monitors for an existing window', async () => {
    const session = sessionWith([{ windowId: 'lab', appId: TARGET_APP, monitorId: '0' }]);

    // Monitor 0's copy of the app is not monitor 1's to drive.
    const resolved = await resolveOn(session, '1', { launch: false });

    expect(resolved).toEqual({ found: false, attemptedLaunch: false });
  });

  it('refuses without opening anything when the caller may not launch', async () => {
    const session = sessionWith([]);
    const emitted: ActionEvent[] = [];
    const off = actionEmitter.onAction((e) => {
      if (e.sessionId === SESSION) emitted.push(e);
    });

    const resolved = await resolveOn(session, '0', { launch: false });
    off();

    expect(resolved).toEqual({ found: false, attemptedLaunch: false });
    expect(emitted.filter((e) => e.action.type === 'window.create')).toHaveLength(0);
  });

  it('opens a window when the app has none on this monitor', async () => {
    const session = sessionWith([]);
    const off = answerRenderFeedback();

    const resolved = await resolveOn(session, '0');
    off();

    expect(resolved).toEqual({ found: true, windowId: TARGET_APP, launched: true });
  });

  it('opens it minimized when the control entry says background', async () => {
    const session = sessionWith([]);
    const emitted: ActionEvent[] = [];
    const off = actionEmitter.onAction((e) => {
      if (e.sessionId === SESSION) emitted.push(e);
    });
    const answering = answerRenderFeedback();

    await resolveOn(session, '0', { launch: true, background: true });
    off();
    answering();

    const create = emitted.find((e) => e.action.type === 'window.create');
    expect((create?.action as { minimized?: boolean }).minimized).toBe(true);
  });

  it('steps past a window already holding the derived id instead of refusing', async () => {
    // A plain window whose title derived the same id. Pinning the create to the appId
    // made this a hard "could not be opened to control" — a *named* id that is already
    // live is refused outright, since naming one is a claim about which window you mean.
    const session = sessionWith([{ windowId: TARGET_APP, monitorId: '0' }]);
    const off = answerRenderFeedback();

    const resolved = await resolveOn(session, '0');
    off();

    expect(resolved).toEqual({ found: true, windowId: `${TARGET_APP}-2`, launched: true });
  });
});
