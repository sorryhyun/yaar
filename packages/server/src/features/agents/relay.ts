/**
 * Relay logic for forwarding messages to the monitor agent.
 *
 * Builds a relay-tagged message and submits it as a monitor task.
 */

import type { ContextPool } from '../../agents/context-pool.js';
import { genId } from '../../lib/ids.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('relay_to_main');

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
  const messageId = genId('relay');
  const content = `<relay from="${agentId}">\n${message}\n</relay>`;

  pool
    .handleTask({ requestedType: 'monitor', kind: 'relay', messageId, content, monitorId })
    .catch((err: unknown) => log.error('relay failed', { messageId, err }));

  return messageId;
}
