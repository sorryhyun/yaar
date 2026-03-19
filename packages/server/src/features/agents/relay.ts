/**
 * Relay logic for forwarding messages to the monitor agent.
 *
 * Builds a relay-tagged message and submits it as a monitor task.
 */

import type { ContextPool } from '../../agents/context-pool.js';

/**
 * Relay a message from the current agent to the monitor agent.
 *
 * Wraps the message in <relay> tags, generates a messageId, and
 * fires the task asynchronously (errors are logged, not thrown).
 * Returns the generated messageId.
 */
export function relayToMonitor(
  pool: ContextPool,
  agentId: string,
  monitorId: string,
  message: string,
): string {
  const messageId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const content = `<relay from="${agentId}">\n${message}\n</relay>`;

  pool
    .handleTask({ type: 'monitor', messageId, content, monitorId })
    .catch((err: unknown) => console.error('[relay_to_main] Failed:', err));

  return messageId;
}
