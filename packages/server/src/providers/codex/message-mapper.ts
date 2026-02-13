/**
 * Codex app-server notification mapper.
 *
 * Converts JSON-RPC notifications from the app-server to StreamMessage format.
 * Uses generated types from the Codex schema for type-safe notification handling.
 */

import type { StreamMessage } from '../types.js';
import type {
  AgentMessageDeltaNotification,
  ReasoningTextDeltaNotification,
  TurnCompletedNotification,
  ErrorNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  ThreadItem,
} from './types.js';

/** Extract the mcpToolCall variant from ThreadItem */
type McpToolCallItem = Extract<ThreadItem, { type: 'mcpToolCall' }>;

/** Extract the commandExecution variant from ThreadItem */
type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;

/** Format MCP tool name with server namespace: "apps:typecheck" */
function mcpToolName(server?: string, tool?: string): string {
  if (server && tool) return `${server}:${tool}`;
  return tool ?? 'mcp_tool';
}

/**
 * Map a JSON-RPC notification to a StreamMessage.
 * Returns null for notifications that should be skipped.
 *
 * @param method - The notification method name
 * @param params - The notification parameters
 * @returns A StreamMessage or null if the notification should be skipped
 */
export function mapNotification(method: string, params: unknown): StreamMessage | null {
  switch (method) {
    // ========================================================================
    // Turn lifecycle events
    // ========================================================================

    case 'turn/started':
      // Turn started, no content to yield
      return null;

    case 'turn/completed': {
      const p = params as TurnCompletedNotification;
      if (p.turn?.status === 'interrupted') {
        return { type: 'error', error: 'Turn was interrupted' };
      }
      if (p.turn?.status === 'failed') {
        return { type: 'error', error: p.turn.error?.message ?? 'Turn failed' };
      }
      return { type: 'complete' };
    }

    case 'turn/failed': {
      // Legacy event — not in generated schema but still emitted by some versions
      const p = params as { error?: string; message?: string } | undefined;
      return { type: 'error', error: p?.error ?? p?.message ?? 'Turn failed' };
    }

    // ========================================================================
    // Agent message events (streaming text response)
    // ========================================================================

    case 'item/agentMessage/delta': {
      const p = params as AgentMessageDeltaNotification;
      if (p.delta) {
        return { type: 'text', content: p.delta };
      }
      return null;
    }

    case 'item/agentMessage/completed':
      // Already streamed via deltas, skip the completed snapshot
      return null;

    // ========================================================================
    // Reasoning events (thinking/chain-of-thought)
    // ========================================================================

    case 'item/reasoning/textDelta': {
      const p = params as ReasoningTextDeltaNotification;
      if (p.delta) {
        return { type: 'thinking', content: p.delta };
      }
      return null;
    }

    case 'item/reasoning/completed':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/summaryTextCompleted':
    case 'item/reasoning/summaryPartAdded':
      // Reasoning lifecycle/summary events — skip silently
      return null;

    // ========================================================================
    // Item lifecycle events (covers MCP, commands, file changes, etc.)
    // ========================================================================

    case 'item/started': {
      const p = params as ItemStartedNotification;
      const item = p.item;
      switch (item?.type) {
        case 'mcpToolCall':
          return {
            type: 'tool_use',
            toolName: mcpToolName(item.server, item.tool),
            toolInput: item.arguments,
          };
        case 'commandExecution':
          return {
            type: 'tool_use',
            toolName: 'command',
            toolInput: { command: item.command },
          };
        default:
          console.debug(
            `[codex] item/started: type=${item?.type ?? 'unknown'} id=${item?.id ?? 'unknown'} turn=${p.turnId ?? '?'}`,
          );
          return null;
      }
    }

    case 'item/completed': {
      const p = params as ItemCompletedNotification;
      const item = p.item;
      switch (item?.type) {
        case 'mcpToolCall':
          if (item.error) {
            return {
              type: 'tool_result',
              toolName: mcpToolName(item.server, item.tool),
              content: `Error: ${item.error.message}`,
            };
          }
          return {
            type: 'tool_result',
            toolName: mcpToolName(item.server, item.tool),
            content: formatMcpResult(item),
          };
        case 'commandExecution':
          return {
            type: 'tool_result',
            toolName: 'command',
            content: formatCommandResult(item),
          };
        default:
          console.debug(
            `[codex] item/completed: type=${item?.type ?? 'unknown'} id=${item?.id ?? 'unknown'} turn=${p.turnId ?? '?'}`,
          );
          return null;
      }
    }

    // ========================================================================
    // MCP tool call sub-events (also handled via item/started + item/completed)
    // ========================================================================

    case 'item/mcpToolCall/started': {
      const item = params as Partial<McpToolCallItem> | undefined;
      return {
        type: 'tool_use',
        toolName: mcpToolName(item?.server, item?.tool),
        toolInput: item?.arguments,
      };
    }

    case 'item/mcpToolCall/completed': {
      const item = params as Partial<McpToolCallItem> | undefined;
      if (item?.error) {
        return {
          type: 'tool_result',
          toolName: mcpToolName(item?.server, item?.tool),
          content: `Error: ${item.error.message}`,
        };
      }
      return {
        type: 'tool_result',
        toolName: mcpToolName(item?.server, item?.tool),
        content: formatMcpResult(item),
      };
    }

    // ========================================================================
    // Command execution sub-events
    // ========================================================================

    case 'item/commandExecution/started': {
      const item = params as Partial<CommandExecutionItem> | undefined;
      return {
        type: 'tool_use',
        toolName: 'command',
        toolInput: { command: item?.command },
      };
    }

    case 'item/commandExecution/completed': {
      const item = params as Partial<CommandExecutionItem> | undefined;
      return {
        type: 'tool_result',
        toolName: 'command',
        content: formatCommandResult(item),
      };
    }

    // ========================================================================
    // Error events
    // ========================================================================

    case 'error': {
      const p = params as ErrorNotification;
      const message = p.error?.message ?? 'Unknown error';
      return { type: 'error', error: message };
    }

    // ========================================================================
    // Unknown/unhandled events
    // ========================================================================

    default:
      // Skip noisy codex internal events
      if (
        method.startsWith('codex/event/') ||
        method === 'thread/tokenUsage/updated' ||
        method === 'account/rateLimits/updated'
      ) {
        return null;
      }
      // Log truly unknown events for debugging
      console.debug(`[codex] Unknown notification: ${method}`, params);
      return null;
  }
}

/**
 * Format MCP tool call result as a string.
 */
function formatMcpResult(item: Partial<McpToolCallItem> | undefined): string {
  if (!item?.result) {
    return 'Tool completed';
  }

  // content is Array<JsonValue> in the generated type
  const content = item.result.content;
  if (Array.isArray(content) && content.length > 0) {
    const contentParts = content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return (block as { text: string }).text;
        }
        return JSON.stringify(block);
      })
      .filter(Boolean);

    if (contentParts.length > 0) {
      return contentParts.join('\n');
    }
  }

  // Fall back to structured content
  if (item.result.structuredContent != null) {
    return JSON.stringify(item.result.structuredContent, null, 2);
  }

  return 'Tool completed';
}

/**
 * Format command execution result as a string.
 */
function formatCommandResult(item: Partial<CommandExecutionItem> | undefined): string {
  const parts: string[] = [];

  if (item?.command) {
    parts.push(`$ ${item.command}`);
  }

  if (item?.aggregatedOutput) {
    parts.push(item.aggregatedOutput);
  }

  if (item?.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0) {
    parts.push(`[exit code: ${item.exitCode}]`);
  }

  return parts.join('\n') || 'Command completed';
}
