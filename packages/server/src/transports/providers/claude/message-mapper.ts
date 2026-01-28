/**
 * Claude SDK message mapper.
 *
 * Converts Claude Agent SDK messages to StreamMessage format.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamMessage } from '../../types.js';

/**
 * Map a Claude SDK message to a StreamMessage.
 * Returns null for messages that should be skipped.
 */
export function mapClaudeMessage(msg: SDKMessage): StreamMessage | null {
  // SDK message types: system, assistant, user, result, stream_event
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { type: 'text', sessionId: msg.session_id };
  }

  if (msg.type === 'assistant') {
    const content = extractAssistantContent(msg.message);
    return { type: 'text', content, sessionId: msg.session_id };
  }

  if (msg.type === 'stream_event') {
    return mapStreamEvent(msg.event);
  }

  if (msg.type === 'result') {
    return { type: 'complete', sessionId: msg.session_id };
  }

  // Skip user messages and other types
  return null;
}

/**
 * Map a stream event to a StreamMessage.
 */
function mapStreamEvent(event: unknown): StreamMessage | null {
  if (!event || typeof event !== 'object') return null;

  const evt = event as { type: string; delta?: unknown };

  if (evt.type === 'content_block_delta') {
    const delta = evt.delta as { type: string; text?: string; thinking?: string } | undefined;
    if (!delta) return null;

    if (delta.type === 'text_delta' && delta.text) {
      return { type: 'text', content: delta.text };
    }
    if (delta.type === 'thinking_delta' && delta.thinking) {
      return { type: 'thinking', content: delta.thinking };
    }
  }

  // Skip other stream events
  return null;
}

/**
 * Extract text content from an assistant message.
 */
function extractAssistantContent(message: unknown): string {
  if (!message || typeof message !== 'object') return '';

  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>).type === 'text'
      )
      .map((block) => block.text)
      .join('');
  }

  return '';
}
