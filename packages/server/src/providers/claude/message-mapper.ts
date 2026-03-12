/**
 * Claude SDK message mapper.
 *
 * Converts Claude Agent SDK messages to StreamMessage format.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SUBAGENT_TOOL_NAME } from '@yaar/shared';
import type { StreamMessage } from '../types.js';

/** Track tool_use_id → toolName from content_block_start events */
const toolNameById = new Map<string, string>();

/** Buffer pending tool_use blocks: accumulate input_json_delta, emit at content_block_stop */
interface PendingToolUse {
  toolName: string;
  toolUseId?: string;
  inputChunks: string[];
}
const pendingToolUse = new Map<number, PendingToolUse>();
let currentBlockIndex = -1;

/**
 * Map a Claude SDK message to a StreamMessage.
 * Returns null for messages that should be skipped.
 */
export function mapClaudeMessage(msg: SDKMessage): StreamMessage | null {
  // Log important message types (skip noisy stream_event)
  const msgType = (msg as { type: string; subtype?: string }).type;
  const msgSubtype = (msg as { subtype?: string }).subtype;
  if (msgType !== 'stream_event') {
    const subtypeStr = msgSubtype ? `, subtype=${msgSubtype}` : '';
    console.log(`[message-mapper] ${msgType}${subtypeStr}`);
  }

  // SDK message types: system, assistant, user, result, stream_event
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { type: 'text', sessionId: msg.session_id };
  }

  // Subagent lifecycle events
  if (msg.type === 'system' && msg.subtype === 'task_started') {
    const m = msg as { task_id?: string; description?: string };
    return {
      type: 'tool_use',
      toolName: SUBAGENT_TOOL_NAME,
      toolUseId: m.task_id,
      toolInput: { description: m.description },
    };
  }
  if (msg.type === 'system' && msg.subtype === 'task_progress') {
    const m = msg as { task_id?: string; last_tool_name?: string; description?: string };
    if (m.last_tool_name) {
      return {
        type: 'tool_use',
        toolName: `${SUBAGENT_TOOL_NAME}:${m.last_tool_name}`,
        toolUseId: m.task_id,
        toolInput: { description: m.description },
      };
    }
    if (m.description) {
      return {
        type: 'tool_use',
        toolName: SUBAGENT_TOOL_NAME,
        toolUseId: m.task_id,
        toolInput: { description: m.description },
      };
    }
    return null;
  }
  if (msg.type === 'system' && msg.subtype === 'task_notification') {
    const m = msg as { task_id?: string; summary?: string };
    return {
      type: 'tool_result',
      toolName: SUBAGENT_TOOL_NAME,
      toolUseId: m.task_id,
      content: m.summary ?? 'Task completed',
    };
  }

  if (msg.type === 'assistant') {
    // Don't return content here - it was already streamed via stream_event.
    // Only return sessionId for session tracking.
    return { type: 'text', sessionId: msg.session_id };
  }

  if (msg.type === 'stream_event') {
    return mapStreamEvent(msg.event);
  }

  if (msg.type === 'result') {
    // SDK result can be success or error - check for error subtypes
    const result = msg as {
      type: 'result';
      subtype?: string;
      is_error?: boolean;
      errors?: string[];
      session_id: string;
    };

    // Check for errors (SDKResultError type)
    if (result.is_error || result.subtype?.startsWith('error')) {
      const errorMessage = result.errors?.join('; ') || 'Unknown SDK error';
      console.error(`[message-mapper] SDK error: ${errorMessage} (subtype: ${result.subtype})`);
      return { type: 'error', error: errorMessage, sessionId: result.session_id };
    }

    return { type: 'complete', sessionId: result.session_id };
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

  const evt = event as {
    type: string;
    index?: number;
    delta?: unknown;
    content_block?: unknown;
  };

  if (evt.type === 'content_block_start') {
    const block = evt.content_block as { type: string; name?: string; id?: string } | undefined;
    if (block?.type === 'tool_use' && block.name) {
      if (block.id) toolNameById.set(block.id, block.name);
      const idx = evt.index ?? ++currentBlockIndex;
      currentBlockIndex = idx;
      // Buffer: don't emit yet — wait for input_json_delta + content_block_stop
      pendingToolUse.set(idx, {
        toolName: block.name,
        toolUseId: block.id,
        inputChunks: [],
      });
      return null;
    }
  }

  if (evt.type === 'content_block_delta') {
    const delta = evt.delta as
      | {
          type: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        }
      | undefined;
    if (!delta) return null;

    if (delta.type === 'text_delta' && delta.text) {
      return { type: 'text', content: delta.text };
    }
    if (delta.type === 'thinking_delta' && delta.thinking) {
      return { type: 'thinking', content: delta.thinking };
    }
    if (delta.type === 'input_json_delta' && delta.partial_json) {
      const idx = evt.index ?? currentBlockIndex;
      const pending = pendingToolUse.get(idx);
      if (pending) {
        pending.inputChunks.push(delta.partial_json);
      }
      return null;
    }
  }

  if (evt.type === 'content_block_stop') {
    const idx = evt.index ?? currentBlockIndex;
    const pending = pendingToolUse.get(idx);
    if (pending) {
      pendingToolUse.delete(idx);
      let toolInput: Record<string, unknown> | undefined;
      if (pending.inputChunks.length > 0) {
        try {
          toolInput = JSON.parse(pending.inputChunks.join(''));
        } catch {
          // Malformed JSON — emit without input
        }
      }
      return {
        type: 'tool_use',
        toolName: pending.toolName,
        toolUseId: pending.toolUseId,
        toolInput,
      };
    }
  }

  // Skip other stream events
  return null;
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
              (item as Record<string, unknown>).type === 'text',
          )
          .map((item) => item.text)
          .join('');
      }

      if (resultText) {
        // Look up tool name from prior content_block_start event
        const toolName =
          (toolResult.tool_use_id && toolNameById.get(toolResult.tool_use_id)) ?? 'mcp_tool';
        if (toolResult.tool_use_id) toolNameById.delete(toolResult.tool_use_id);
        return {
          type: 'tool_result',
          toolName,
          content: resultText,
          toolUseId: toolResult.tool_use_id,
        };
      }
    }
  }

  return null;
}
