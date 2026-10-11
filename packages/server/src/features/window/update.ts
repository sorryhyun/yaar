/**
 * Window content update logic.
 */

import type { ContentUpdateOperation } from '@yaar/shared';
import { ok, error, type VerbResult } from '../../lib/verb-result.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { getAgentId } from '../../agents/agent-context.js';
import {
  formatWindowRef,
  requireWindowExists,
  requireWindowUnlocked,
  emitWindowAction,
} from './helpers.js';
import { namesInlinableUri, inlineUriContent } from './inline-content.js';
import { parseComponentLayout } from './component-layout.js';

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

  let data: unknown = payload.content ?? '';

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

  // A component window's content is a whole layout: only `replace` and `clear` mean anything,
  // and the layout is validated the way `create` validates it (component-layout.ts).
  if (renderer === 'component') {
    if (opType === 'replace') {
      const result = parseComponentLayout(data);
      if (!result.ok) return error(result.message);
      data = result.layout;
    } else if (opType === 'append' || opType === 'prepend' || opType === 'insertAt') {
      return error(
        `Operation "${opType}" does not apply to a component window — use "replace" with the ` +
          'full layout { components: [...] }.',
      );
    }
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

  // Not awaited: the lock, the only reason the frontend would refuse this, was checked
  // above (see emitWindowAction).
  emitWindowAction(osAction, agentId);

  return ok(`Updated window "${formatWindowRef(windowId)}" (${opType})`);
}
