/**
 * Window content update logic.
 */

import type { ContentUpdateOperation } from '@yaar/shared';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { ok, error } from '../../handlers/utils.js';
import { getAgentId } from '../../agents/agent-context.js';
import {
  formatWindowRef,
  requireWindowExists,
  requireWindowUnlocked,
  emitActionChecked,
} from './helpers.js';

/** Handle window content updates (append, prepend, replace, insertAt, clear). */
export async function handleUpdate(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const existsErr = requireWindowExists(windowState, windowId);
  if (existsErr) return existsErr;

  const agentId = getAgentId();
  const lockErr = requireWindowUnlocked(windowState, windowId, agentId);
  if (lockErr) return lockErr;

  const opType = payload.operation as string;
  if (!opType) return error('"operation" is required (append, prepend, replace, insertAt, clear).');

  const data = (payload.content as string | { headers: string[]; rows: string[][] }) ?? '';

  let operation: ContentUpdateOperation;
  switch (opType) {
    case 'append':
      operation = { op: 'append', data };
      break;
    case 'prepend':
      operation = { op: 'prepend', data };
      break;
    case 'replace':
      operation = { op: 'replace', data };
      break;
    case 'insertAt':
      if (payload.position === undefined) return error('position is required for insertAt.');
      operation = { op: 'insertAt', position: payload.position as number, data };
      break;
    case 'clear':
      operation = { op: 'clear' };
      break;
    default:
      return error(`Unknown operation "${opType}".`);
  }

  const osAction = {
    type: 'window.updateContent' as const,
    windowId,
    operation,
    renderer: payload.renderer as string | undefined,
  };

  const err = await emitActionChecked(
    osAction,
    500,
    `Window "${windowId}" is locked by another agent.`,
  );
  if (err) return err;

  return ok(`Updated window "${formatWindowRef(windowId)}" (${opType})`);
}
