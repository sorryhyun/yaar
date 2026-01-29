/**
 * Claude SDK message mapper.
 *
 * Converts Claude Agent SDK messages to StreamMessage format.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamMessage } from '../types.js';

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

  // Handle user messages containing tool results
  if (msg.type === 'user') {
    return extractToolResult(msg.message);
  }

  // Skip other types
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

/**
 * Extract tool result from a user message.
 * User messages in Claude's conversation format contain tool_result blocks.
 */
function extractToolResult(message: unknown): StreamMessage | null {
  if (!message || typeof message !== 'object') return null;

  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (!Array.isArray(content)) return null;

  // Look for tool_result blocks
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'tool_result'
    ) {
      const toolResult = block as {
        type: string;
        tool_use_id?: string;
        content?: unknown;
      };

      // Extract the text content from the tool result
      let resultText = '';
      if (typeof toolResult.content === 'string') {
        resultText = toolResult.content;
      } else if (Array.isArray(toolResult.content)) {
        resultText = toolResult.content
          .filter(
            (item): item is { type: string; text: string } =>
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'text'
          )
          .map((item) => item.text)
          .join('');
      }

      if (resultText) {
        return {
          type: 'tool_result',
          toolName: 'mcp_tool',
          content: resultText,
        };
      }
    }
  }

  return null;
}
