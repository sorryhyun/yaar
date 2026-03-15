/**
 * Window subscription event helpers.
 *
 * Maps OS Actions to WindowChangeEvent types and provides
 * human-readable summaries for subscription notifications.
 */

import type { OSAction, WindowChangeEvent } from '@yaar/shared';

const ACTION_TO_EVENT: Record<string, WindowChangeEvent> = {
  'window.setContent': 'content',
  'window.updateContent': 'content',
  'window.close': 'close',
  'window.lock': 'lock',
  'window.unlock': 'unlock',
  'window.move': 'move',
  'window.resize': 'resize',
  'window.setTitle': 'title',
};

/**
 * Normalize an agentId (role) to the agentKey used by WindowSubscriptionPolicy.
 * Window agents: "window-{windowId}/action-123" → "{windowId}"
 * Main agents: "main-{monitorId}" → "main-{monitorId}"
 */
export function normalizeAgentKey(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  if (agentId.startsWith('window-')) {
    return agentId.replace(/^window-/, '').replace(/\/.*$/, '');
  }
  return agentId;
}

export function mapActionToSubscriptionEvent(action: OSAction): WindowChangeEvent | undefined {
  return ACTION_TO_EVENT[action.type];
}

export function summarizeAction(action: OSAction, event: WindowChangeEvent): string {
  const windowId = (action as { windowId?: string }).windowId ?? 'unknown';
  switch (event) {
    case 'content':
      return `Window "${windowId}" content was updated (${action.type.replace('window.', '')}).`;
    case 'close':
      return `Window "${windowId}" was closed.`;
    case 'lock':
      return `Window "${windowId}" was locked.`;
    case 'unlock':
      return `Window "${windowId}" was unlocked.`;
    case 'move':
      return `Window "${windowId}" was moved.`;
    case 'resize':
      return `Window "${windowId}" was resized.`;
    case 'title':
      return `Window "${windowId}" title was changed.`;
    default:
      return `Window "${windowId}" changed (${event}).`;
  }
}
