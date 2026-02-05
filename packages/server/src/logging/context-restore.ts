import type { ParsedMessage } from './types.js';
import type { ContextMessage, ContextSource } from '../agents/context.js';

/**
 * Extract context tape messages from parsed session logs.
 *
 * Restores only main conversation messages (user + assistant).
 * Window agent messages are skipped because:
 * - User messages have baked-in <previous_conversation> prefixes
 * - Window agents get main context anyway via formatForPrompt
 * - Window content is available via view_window tool after restore
 */
export function getContextRestoreMessages(messages: ParsedMessage[]): ContextMessage[] {
  const result: ContextMessage[] = [];

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
    if (!msg.content) continue;

    // Only restore main agent messages (agentId starts with "main-")
    if (!msg.agentId.startsWith('main-')) continue;

    const source: ContextSource = 'main';

    result.push({
      role: msg.type,
      content: msg.content,
      timestamp: msg.timestamp,
      source,
    });
  }

  return result;
}
