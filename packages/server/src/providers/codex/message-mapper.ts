/**
 * Codex SDK message mapper.
 *
 * Converts Codex SDK events and items to StreamMessage format.
 */

import type {
  ThreadEvent,
  ThreadItem,
  CommandExecutionItem,
  McpToolCallItem,
  FileChangeItem,
  AgentMessageItem,
  ReasoningItem,
  WebSearchItem,
} from '@openai/codex-sdk';
import type { StreamMessage } from '../../types.js';

/**
 * Map a Codex thread event to a StreamMessage.
 * Returns null for events that should be skipped.
 */
export function mapCodexEvent(event: ThreadEvent): StreamMessage | null {
  switch (event.type) {
    case 'thread.started':
      return { type: 'text', sessionId: event.thread_id };

    case 'item.completed':
      return mapCompletedItem(event.item);

    case 'item.updated':
      return mapUpdatedItem(event.item);

    case 'turn.completed':
      return { type: 'complete' };

    case 'turn.failed':
      return { type: 'error', error: event.error?.message ?? 'Turn failed' };

    case 'error':
      return { type: 'error', error: event.message ?? 'Thread error' };

    // Skip turn.started and item.started as they don't carry useful content
    case 'turn.started':
    case 'item.started':
    default:
      return null;
  }
}

/**
 * Map a completed thread item to a StreamMessage.
 */
function mapCompletedItem(item: ThreadItem): StreamMessage | null {
  switch (item.type) {
    case 'agent_message':
      return { type: 'text', content: (item as AgentMessageItem).text };

    case 'reasoning':
      return { type: 'thinking', content: (item as ReasoningItem).text };

    case 'command_execution': {
      const cmdItem = item as CommandExecutionItem;
      return {
        type: 'tool_result',
        toolName: 'command',
        content: formatCommandResult(cmdItem),
      };
    }

    case 'mcp_tool_call': {
      const mcpItem = item as McpToolCallItem;
      return {
        type: 'tool_result',
        toolName: mcpItem.tool ?? 'mcp_tool',
        content: formatMcpResult(mcpItem),
      };
    }

    case 'file_change': {
      const fileItem = item as FileChangeItem;
      const paths = fileItem.changes.map((c) => c.path).join(', ');
      return {
        type: 'tool_result',
        toolName: 'file_edit',
        content: `Files: ${paths}`,
      };
    }

    case 'web_search': {
      const searchItem = item as WebSearchItem;
      return {
        type: 'tool_result',
        toolName: 'web_search',
        content: searchItem.query ?? 'web search',
      };
    }

    case 'error':
      return { type: 'error', error: item.message };

    case 'todo_list':
      // Skip todo list items for now
      return null;

    default:
      return null;
  }
}

/**
 * Map an updated thread item to a StreamMessage.
 * Used for streaming partial content.
 */
function mapUpdatedItem(item: ThreadItem): StreamMessage | null {
  switch (item.type) {
    case 'agent_message':
      // Stream partial agent messages
      return { type: 'text', content: (item as AgentMessageItem).text };

    case 'reasoning':
      // Stream partial reasoning
      return { type: 'thinking', content: (item as ReasoningItem).text };

    case 'command_execution': {
      // Show tool is running
      const cmdItem = item as CommandExecutionItem;
      return {
        type: 'tool_use',
        toolName: 'command',
        toolInput: { command: cmdItem.command },
      };
    }

    case 'mcp_tool_call': {
      const mcpItem = item as McpToolCallItem;
      return {
        type: 'tool_use',
        toolName: mcpItem.tool ?? 'mcp_tool',
        toolInput: mcpItem.arguments,
      };
    }

    default:
      return null;
  }
}

/**
 * Format command execution result as a string.
 */
function formatCommandResult(item: CommandExecutionItem): string {
  const parts: string[] = [];

  if (item.command) {
    parts.push(`$ ${item.command}`);
  }

  if (item.aggregated_output) {
    parts.push(item.aggregated_output);
  }

  if (item.exit_code !== undefined && item.exit_code !== 0) {
    parts.push(`[exit code: ${item.exit_code}]`);
  }

  return parts.join('\n') || 'Command completed';
}

/**
 * Format MCP tool call result as a string.
 */
function formatMcpResult(item: McpToolCallItem): string {
  if (item.error) {
    return `Error: ${item.error.message}`;
  }

  if (item.result) {
    // Format the content blocks
    const contentParts = item.result.content
      .map((block) => {
        if ('text' in block) {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .filter(Boolean);

    if (contentParts.length > 0) {
      return contentParts.join('\n');
    }

    // Fall back to structured content
    if (item.result.structured_content !== undefined) {
      return JSON.stringify(item.result.structured_content, null, 2);
    }
  }

  return 'Tool completed';
}
