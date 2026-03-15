/**
 * Window management logic (close, lock, unlock).
 */

import type { OSAction } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getAgentId } from '../../agents/session.js';
import { formatWindowRef, requireWindowExists, emitActionChecked } from './helpers.js';

/** Handle window management actions (close, lock, unlock). */
export async function handleManage(
  windowState: WindowStateRegistry,
  windowId: string,
  action: 'close' | 'lock' | 'unlock',
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
