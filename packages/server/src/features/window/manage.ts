/**
 * Window management logic (close, reload, lock, unlock).
 */

import type { OSAction } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getAgentId } from '../../agents/agent-context.js';
import { formatWindowRef, requireWindowExists, emitActionChecked } from './helpers.js';

/** Handle window management actions (close, reload, lock, unlock). */
export async function handleManage(
  windowState: WindowStateRegistry,
  windowId: string,
  action: 'close' | 'reload' | 'lock' | 'unlock',
): Promise<VerbResult> {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;

  const agentId = getAgentId();
  const lockedBy = windowState.isLockedByOther(windowId, agentId);

  switch (action) {
    case 'close': {
      if (lockedBy) return error(`Window "${windowId}" is locked by agent "${lockedBy}".`);
      const closeErr = await emitActionChecked(
        { type: 'window.close', windowId } satisfies OSAction,
        500,
        `Failed to close window "${windowId}": ${windowId}`,
      );
      if (closeErr) return closeErr;
      return ok(`Closed window "${formatWindowRef(windowId)}"`);
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
