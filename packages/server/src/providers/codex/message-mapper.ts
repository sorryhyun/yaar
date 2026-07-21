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

/** Extract the webSearch variant from ThreadItem */
type WebSearchItem = Extract<ThreadItem, { type: 'webSearch' }>;

/** Extract the collabAgentToolCall variant from ThreadItem */
type CollabAgentToolCallItem = Extract<ThreadItem, { type: 'collabAgentToolCall' }>;

/** Format MCP tool name with server namespace: "apps:typecheck" */
function mcpToolName(server?: string, tool?: string): string {
  if (server && tool) return `${server}:${tool}`;
  return tool ?? 'mcp_tool';
}

// ============================================================================
// Item mappers
//
// An item reaches the mapper two ways: inside `item/started` / `item/completed`
// (where the item's own `type` selects the mapper) and as a dedicated
// `item/{kind}/{phase}` notification (where the method name does). Both spell
// the same StreamMessage, so both call the same mapper. These take the item as
// `Partial<…> | undefined` because the sub-event params are the item itself and
// carry no guarantee of any field — including `type`, which is why the sub-event
// cases cannot be routed through the type switch.
// ============================================================================

function mapMcpToolCallStarted(item: Partial<McpToolCallItem> | undefined): StreamMessage {
  return {
    type: 'tool_use',
    toolName: mcpToolName(item?.server, item?.tool),
    toolInput: item?.arguments,
  };
}

function mapMcpToolCallCompleted(item: Partial<McpToolCallItem> | undefined): StreamMessage {
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

function mapCommandExecutionStarted(
  item: Partial<CommandExecutionItem> | undefined,
): StreamMessage {
  return {
    type: 'tool_use',
    toolName: 'command',
    toolInput: { command: item?.command },
  };
}

function mapCommandExecutionCompleted(
  item: Partial<CommandExecutionItem> | undefined,
): StreamMessage {
  return {
    type: 'tool_result',
    toolName: 'command',
    content: formatCommandResult(item),
  };
}

/** Map the item carried by an `item/started` notification. */
function mapItemStarted(p: ItemStartedNotification): StreamMessage | null {
  const item = p.item;
  switch (item?.type) {
    case 'mcpToolCall':
      return mapMcpToolCallStarted(item);
    case 'commandExecution':
      return mapCommandExecutionStarted(item);
    case 'webSearch':
      return {
        type: 'tool_use',
        toolName: 'web_search',
        toolUseId: item.id,
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_use',
        toolName: `collab:${item.tool}`,
        toolUseId: item.id,
        toolInput: { prompt: item.prompt, agents: item.receiverThreadIds },
      };
    default:
      console.debug(
        `[codex] item/started: type=${item?.type ?? 'unknown'} id=${item?.id ?? 'unknown'} turn=${p.turnId ?? '?'}`,
      );
      return null;
  }
}

/** Map the item carried by an `item/completed` notification. */
function mapItemCompleted(p: ItemCompletedNotification): StreamMessage | null {
  const item = p.item;
  switch (item?.type) {
    case 'mcpToolCall':
      return mapMcpToolCallCompleted(item);
    case 'commandExecution':
      return mapCommandExecutionCompleted(item);
    case 'webSearch':
      return {
        type: 'tool_result',
        toolName: 'web_search',
        toolUseId: item.id,
        content: formatWebSearchResult(item),
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_result',
        toolName: `collab:${item.tool}`,
        toolUseId: item.id,
        content: formatCollabResult(item as CollabAgentToolCallItem),
      };
    default:
      console.debug(
        `[codex] item/completed: type=${item?.type ?? 'unknown'} id=${item?.id ?? 'unknown'} turn=${p.turnId ?? '?'}`,
      );
      return null;
  }
}

/** Noisy codex internal events, skipped without a debug log. */
const IGNORED_PREFIXES = ['codex/event/', 'fuzzyFileSearch/'];

const IGNORED_METHODS = new Set([
  'thread/tokenUsage/updated',
  'thread/compacted',
  'account/rateLimits/updated',
  'account/updated',
  'account/login/completed',
  'app/list/updated',
  'model/rerouted',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/fileChange/outputDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/plan/delta',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'rawResponseItem/completed',
]);

function isIgnoredNotification(method: string): boolean {
  return (
    IGNORED_PREFIXES.some((prefix) => method.startsWith(prefix)) || IGNORED_METHODS.has(method)
  );
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

    case 'item/started':
      return mapItemStarted(params as ItemStartedNotification);

    case 'item/completed':
      return mapItemCompleted(params as ItemCompletedNotification);

    // ========================================================================
    // MCP tool call sub-events (also handled via item/started + item/completed)
    // ========================================================================

    case 'item/mcpToolCall/started':
      return mapMcpToolCallStarted(params as Partial<McpToolCallItem> | undefined);

    case 'item/mcpToolCall/completed':
      return mapMcpToolCallCompleted(params as Partial<McpToolCallItem> | undefined);

    // ========================================================================
    // Command execution sub-events
    // ========================================================================

    case 'item/commandExecution/started':
      return mapCommandExecutionStarted(params as Partial<CommandExecutionItem> | undefined);

    case 'item/commandExecution/completed':
      return mapCommandExecutionCompleted(params as Partial<CommandExecutionItem> | undefined);

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
      if (isIgnoredNotification(method)) {
        return null;
      }
      // Log truly unknown events for debugging
      console.debug(`[codex] Unknown notification: ${method}`, params);
      return null;
  }
}

/**
 * Format a single MCP content block as text.
 *
 * The `StreamMessage` content channel is a string, so non-text blocks must
 * degrade — but that degradation is deliberate here, never a raw `JSON.stringify`
 * dump. Binary-carrying blocks (`image`, `audio`, blob `resource`s) become a short
 * marker instead of their base64 payload; `resource`/`resource_link` surface their
 * text or URI. Only genuinely-unknown shapes fall back to stringification.
 * Returns null for blocks that contribute nothing.
 */
function formatContentBlock(block: unknown): string | null {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return JSON.stringify(block);

  const b = block as Record<string, unknown>;
  const type = typeof b.type === 'string' ? (b.type as string) : undefined;

  // Plain text (either an explicit text block or a bare { text } shape).
  if (typeof b.text === 'string' && (type === undefined || type === 'text')) {
    return b.text;
  }

  switch (type) {
    // Don't dump base64 payloads into the model's text context.
    case 'image':
      return '[image omitted]';
    case 'audio':
      return '[audio omitted]';
    case 'resource': {
      const res = (b.resource ?? {}) as { text?: unknown; uri?: unknown };
      if (typeof res.text === 'string') return res.text;
      if (typeof res.uri === 'string') return `[resource: ${res.uri}]`;
      return '[resource omitted]';
    }
    case 'resource_link': {
      const uri = typeof b.uri === 'string' ? b.uri : '';
      const name = typeof b.name === 'string' ? b.name : 'link';
      return `[${name}](${uri})`;
    }
    default:
      return JSON.stringify(block);
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
    const contentParts = content.map(formatContentBlock).filter(Boolean);

    if (contentParts.length > 0) {
      const body = contentParts.join('\n');
      // Codex surfaces most tool failures as `item.error`, but an MCP result can
      // also carry its own `isError` flag (not in the generated result type, so
      // read defensively). Mark it so the model doesn't read a failure as success.
      return isErrorResult(item.result) ? `Error: ${body}` : body;
    }
  }

  // Fall back to structured content
  if (item.result.structuredContent != null) {
    return JSON.stringify(item.result.structuredContent, null, 2);
  }

  return 'Tool completed';
}

/** Read the MCP-level `isError` flag off a result (absent from the generated type). */
function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * Format collab agent tool call result as a string.
 */
function formatCollabResult(item: CollabAgentToolCallItem): string {
  const parts: string[] = [`tool: ${item.tool}`, `status: ${item.status}`];
  if (item.prompt) parts.push(`prompt: ${item.prompt}`);
  if (item.agentsStates) {
    const stateEntries = Object.entries(item.agentsStates)
      .map(([tid, s]) => {
        if (!s) return `${tid}: unknown`;
        const msg = s.message ? `: ${s.message}` : '';
        return `${tid}: ${s.status}${msg}`;
      })
      .join(', ');
    if (stateEntries) parts.push(`agents: ${stateEntries}`);
  }
  return parts.join('\n');
}

/**
 * Format web search result as a string (v2 camelCase fields).
 */
function formatWebSearchResult(item: WebSearchItem): string {
  const action = item.action;
  if (!action) return item.query;

  const actionDesc =
    action.type === 'search'
      ? (action.queries ?? [action.query]).filter(Boolean).join(', ')
      : action.type === 'openPage'
        ? `open: ${action.url ?? ''}`
        : action.type === 'findInPage'
          ? `find "${action.pattern ?? ''}" in ${action.url ?? ''}`
          : '';

  return actionDesc ? `${item.query} → ${actionDesc}` : item.query;
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
