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
  EventMsg,
  AgentStatus,
  CollabAgentSpawnBeginEvent,
  CollabAgentSpawnEndEvent,
  CollabAgentInteractionBeginEvent,
  CollabAgentInteractionEndEvent,
  CollabWaitingBeginEvent,
  CollabWaitingEndEvent,
  CollabCloseBeginEvent,
  CollabCloseEndEvent,
  CollabResumeBeginEvent,
  CollabResumeEndEvent,
  WebSearchBeginEvent,
  WebSearchEndEvent,
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
    // Event message (v1 events, includes collaboration/subagent events)
    // ========================================================================

    case 'event_msg': {
      return mapEventMsg(params as EventMsg);
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
        if (block && typeof block === 'object') {
          if ('text' in block) return (block as { text: string }).text;
          // Skip image blocks — don't dump base64 data into text
          if ('type' in block && (block as { type: string }).type === 'image') return null;
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
 * Map an EventMsg (v1 event) to a StreamMessage.
 * Primarily handles collaboration/subagent events.
 */
function mapEventMsg(event: EventMsg): StreamMessage | null {
  switch (event.type) {
    case 'collab_agent_spawn_begin': {
      const e = event as CollabAgentSpawnBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'collab:spawnAgent',
        toolUseId: e.call_id,
        toolInput: { prompt: e.prompt },
      };
    }
    case 'collab_agent_spawn_end': {
      const e = event as CollabAgentSpawnEndEvent & { type: string };
      return {
        type: 'tool_result',
        toolName: 'collab:spawnAgent',
        toolUseId: e.call_id,
        content: `status: ${formatAgentStatus(e.status)}${e.new_thread_id ? `, thread: ${e.new_thread_id}` : ''}`,
      };
    }
    case 'collab_agent_interaction_begin': {
      const e = event as CollabAgentInteractionBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'collab:sendInput',
        toolUseId: e.call_id,
        toolInput: { receiver: e.receiver_thread_id, prompt: e.prompt },
      };
    }
    case 'collab_agent_interaction_end': {
      const e = event as CollabAgentInteractionEndEvent & { type: string };
      return {
        type: 'tool_result',
        toolName: 'collab:sendInput',
        toolUseId: e.call_id,
        content: `status: ${formatAgentStatus(e.status)}`,
      };
    }
    case 'collab_waiting_begin': {
      const e = event as CollabWaitingBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'collab:wait',
        toolUseId: e.call_id,
        toolInput: { agents: e.receiver_thread_ids },
      };
    }
    case 'collab_waiting_end': {
      const e = event as CollabWaitingEndEvent & { type: string };
      const statusEntries = Object.entries(e.statuses)
        .map(([tid, s]) => `${tid}: ${formatAgentStatus(s!)}`)
        .join(', ');
      return {
        type: 'tool_result',
        toolName: 'collab:wait',
        toolUseId: e.call_id,
        content: statusEntries || 'all agents completed',
      };
    }
    case 'collab_close_begin': {
      const e = event as CollabCloseBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'collab:closeAgent',
        toolUseId: e.call_id,
        toolInput: { agent: e.receiver_thread_id },
      };
    }
    case 'collab_close_end': {
      const e = event as CollabCloseEndEvent & { type: string };
      return {
        type: 'tool_result',
        toolName: 'collab:closeAgent',
        toolUseId: e.call_id,
        content: `status: ${formatAgentStatus(e.status)}`,
      };
    }
    case 'collab_resume_begin': {
      const e = event as CollabResumeBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'collab:resumeAgent',
        toolUseId: e.call_id,
        toolInput: { agent: e.receiver_thread_id },
      };
    }
    case 'collab_resume_end': {
      const e = event as CollabResumeEndEvent & { type: string };
      return {
        type: 'tool_result',
        toolName: 'collab:resumeAgent',
        toolUseId: e.call_id,
        content: `status: ${formatAgentStatus(e.status)}`,
      };
    }
    case 'web_search_begin': {
      const e = event as WebSearchBeginEvent & { type: string };
      return {
        type: 'tool_use',
        toolName: 'web_search',
        toolUseId: e.call_id,
      };
    }
    case 'web_search_end': {
      const e = event as WebSearchEndEvent & { type: string };
      const actionDesc =
        e.action?.type === 'search'
          ? (e.action.queries ?? [e.action.query]).filter(Boolean).join(', ')
          : e.action?.type === 'open_page'
            ? `open: ${e.action.url ?? ''}`
            : e.action?.type === 'find_in_page'
              ? `find "${e.action.pattern ?? ''}" in ${e.action.url ?? ''}`
              : '';
      return {
        type: 'tool_result',
        toolName: 'web_search',
        toolUseId: e.call_id,
        content: actionDesc ? `${e.query} → ${actionDesc}` : e.query,
      };
    }
    case 'task_complete':
      // Turn completed — may also arrive via turn/completed v2 notification
      return { type: 'complete' };
    case 'agent_message_delta': {
      // Streaming text from a subagent — pass through as text
      const e = event as { type: string; delta?: string };
      if (e.delta) return { type: 'text', content: e.delta };
      return null;
    }
    case 'agent_reasoning_delta': {
      const e = event as { type: string; delta?: string };
      if (e.delta) return { type: 'thinking', content: e.delta };
      return null;
    }
    default:
      // Skip non-collab event_msg events (token_count, session_configured, etc.)
      return null;
  }
}

/**
 * Format an AgentStatus to a human-readable string.
 */
function formatAgentStatus(status: AgentStatus): string {
  if (typeof status === 'string') return status;
  if ('completed' in status) return `completed${status.completed ? `: ${status.completed}` : ''}`;
  if ('errored' in status) return `errored: ${status.errored}`;
  return JSON.stringify(status);
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
