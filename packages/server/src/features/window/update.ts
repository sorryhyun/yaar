/**
 * Window content update logic.
 */

import type { ContentUpdateOperation, OSAction } from '@yaar/shared';
import { actionEmitter } from '../../session/action-emitter.js';
import { ok, error, type VerbResult } from '../../lib/verb-result.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { getAgentId } from '../../agents/agent-context.js';
import {
  formatWindowRef,
  requireWindowExists,
  requireWindowUnlocked,
  emitActionChecked,
} from './helpers.js';
import { namesInlinableUri, inlineUriContent } from './inline-content.js';

/**
 * Handle window updates: content (append, prepend, replace, insertAt, clear) and/or the
 * title. `title` rides the same action rather than a verb of its own because `update` is
 * where an agent reaches for it — before this, a `title` passed alongside `operation` was
 * dropped with a success reply, and one passed alone was refused for lacking `operation`,
 * so the only way to rename a window was to close it and open a copy under a new id.
 */
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

  let title: string | undefined;
  if (payload.title !== undefined) {
    if (typeof payload.title !== 'string' || !payload.title.trim())
      return error('"title" must be a non-empty string.');
    title = payload.title;
  }

  const opType = payload.operation as string | undefined;
  if (!opType) {
    if (title === undefined)
      return error(
        '"operation" is required (append, prepend, replace, insertAt, clear), ' +
          'or pass "title" alone to rename the window.',
      );
    setTitle(windowId, title);
    return ok(`Renamed window "${formatWindowRef(windowId)}" to "${title}".`);
  }

  let data = (payload.content as string | { headers: string[]; rows: string[][] }) ?? '';

  // The same substitution `create` makes, on the same renderers — an update that names a
  // file must not append the pointer's own text to a window (inline-content.ts). The
  // renderer is whatever this call sets it to, or, when it sets none, the one the window
  // is already displaying.
  const renderer =
    (payload.renderer as string | undefined) ?? windowState.getWindow(windowId)?.content.renderer;
  if (namesInlinableUri(renderer, data)) {
    const inlined = await inlineUriContent(renderer as string, data);
    if (!inlined.ok) return error(inlined.message);
    data = inlined.data;
  }

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

  if (title !== undefined) setTitle(windowId, title);
  return ok(
    `Updated window "${formatWindowRef(windowId)}" (${opType})` +
      (title !== undefined ? ` and renamed it to "${title}".` : ''),
  );
}

function setTitle(windowId: string, title: string): void {
  actionEmitter.emitAction({ type: 'window.setTitle', windowId, title } satisfies OSAction);
}
