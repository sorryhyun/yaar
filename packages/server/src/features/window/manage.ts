/**
 * Window management logic (close, minimize, reload, lock, unlock).
 */

import type { OSAction } from '@yaar/shared';
import { ok, error, type VerbResult } from '../../lib/verb-result.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getAgentId, getSessionId } from '../../agents/agent-context.js';
import type { PooledAgent } from '../../agents/agent-roster.js';
import { formatWindowRef, requireWindowExists, emitWindowAction } from './helpers.js';

/** The one question the close path asks of the app-agent tier. */
export interface AppAgentLookup {
  get(monitorId: string, appId: string): PooledAgent | undefined;
}

/** The calling session's app agents, or undefined before its pool exists. */
function sessionAppAgents(): AppAgentLookup | undefined {
  const sid = getSessionId();
  const hub = getSessionHub();
  return (sid ? hub.get(sid) : hub.getDefault())?.getPool()?.agentPool.appAgents;
}

/**
 * The app whose agent this close is about to retire with its working context, if any.
 *
 * Closing an app's last window on a monitor disposes its app agent
 * (`WindowEventCoordinator.handleWindowClose`) — by design, but invisibly to the caller,
 * which tends to close a delegated window to tidy up and reopen it for follow-up work
 * minutes later, to an agent that remembers nothing (issue #180). Asked *before* the
 * close is emitted: the emit folds into the registry synchronously and starts the
 * teardown, after which there is nothing left to ask. Only an agent that has run a turn
 * counts — one that never did had no context to lose.
 */
function appAgentRetiredByClose(
  windowState: WindowStateRegistry,
  windowId: string,
  appAgents: AppAgentLookup | undefined,
): string | undefined {
  const win = windowState.getWindow(windowId);
  const appId = win?.appId;
  const monitorId = windowState.getMonitorForWindow(windowId);
  if (!appId || !monitorId || !appAgents) return undefined;
  const othersRemain = windowState
    .listWindows()
    .some(
      (w) => w !== win && w.appId === appId && windowState.getMonitorForWindow(w.id) === monitorId,
    );
  if (othersRemain) return undefined;
  return appAgents.get(monitorId, appId)?.session.hasConversation() ? appId : undefined;
}

/**
 * Handle window management actions (close, minimize, reload, lock, unlock).
 *
 * `appAgents` defaults to the calling session's; tests pass their own.
 */
export async function handleManage(
  windowState: WindowStateRegistry,
  windowId: string,
  action: 'close' | 'minimize' | 'reload' | 'lock' | 'unlock',
  appAgents: AppAgentLookup | undefined = sessionAppAgents(),
): Promise<VerbResult> {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;

  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);

  switch (action) {
    case 'close': {
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      const retired = appAgentRetiredByClose(windowState, windowId, appAgents);
      emitWindowAction({ type: 'window.close', windowId } satisfies OSAction, agentId);
      const closed = `Closed window "${formatWindowRef(windowId)}"`;
      if (!retired) return ok(closed);
      return ok(
        `${closed}. This retired the "${retired}" app agent and its working context; reopening ` +
          'starts a fresh agent. If you expect follow-up work, minimize the window instead of ' +
          'closing it.',
      );
    }

    case 'minimize': {
      // Keeps the window — and so its app agent — alive, out of the user's way.
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      const variant = windowState.getWindow(windowId)?.variant;
      if (variant === 'widget' || variant === 'panel') {
        return error(`Window "${windowId}" is a ${variant}; only standard windows minimize.`);
      }
      emitWindowAction({ type: 'window.minimize', windowId } satisfies OSAction, agentId);
      return ok(`Minimized window "${formatWindowRef(windowId)}"`);
    }

    case 'reload': {
      // Locked like close: a reload discards whatever the iframe was holding, which is
      // the thing the lock is there to protect. Fire-and-forget unlike close, because
      // there is no server-side state to keep in step — the window record is untouched,
      // and the only effect is in the browser.
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      actionEmitter.emitAction({ type: 'window.reload', windowId } satisfies OSAction);
      return ok(
        `Reloaded window "${formatWindowRef(windowId)}". Its in-memory state is gone; the ` +
          'window, its app agent and its subscriptions are not.',
      );
    }

    case 'lock': {
      if (!agentId) return error('Cannot determine agent identity.');
      if (lockedBy) return error(`Window "${windowId}" is already locked by agent "${lockedBy}".`);
      actionEmitter.emitAction({ type: 'window.lock', windowId, agentId } satisfies OSAction);
      return ok(`Locked window "${formatWindowRef(windowId)}"`);
    }

    case 'unlock': {
      if (!agentId) return error('Cannot determine agent identity.');
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      actionEmitter.emitAction({ type: 'window.unlock', windowId, agentId } satisfies OSAction);
      return ok(`Unlocked window "${formatWindowRef(windowId)}"`);
    }
  }
}

/**
 * Handle window geometry actions (move, resize).
 *
 * Fire-and-forget like lock/unlock: every emitted action is folded back into the
 * server-side window registry by the `onAction` listener in LiveSession, so the bounds
 * stay in sync without waiting on frontend feedback. A window locked by another agent is
 * refused, matching close/lock.
 */
export async function handleGeometry(
  windowState: WindowStateRegistry,
  windowId: string,
  action: 'move' | 'resize',
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;

  const lockedBy = windowState.isLockedByOther(windowId, getAgentId());
  if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);

  if (action === 'resize') {
    const w = payload.width;
    const h = payload.height;
    if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) {
      return error('"width" and "height" (positive numbers) are required for the resize action.');
    }
    actionEmitter.emitAction({ type: 'window.resize', windowId, w, h } satisfies OSAction);
    return ok(`Resized window "${formatWindowRef(windowId)}" to ${w}×${h}.`);
  }

  const x = payload.x;
  const y = payload.y;
  if (typeof x !== 'number' || typeof y !== 'number') {
    return error('"x" and "y" (numbers) are required for the move action.');
  }
  actionEmitter.emitAction({ type: 'window.move', windowId, x, y } satisfies OSAction);
  return ok(`Moved window "${formatWindowRef(windowId)}" to (${x}, ${y}).`);
}
