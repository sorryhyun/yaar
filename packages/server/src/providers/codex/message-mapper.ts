/**
 * Codex app-server notification mapper.
 *
 * Converts JSON-RPC notifications from the app-server to StreamMessage format.
 */

import type { StreamMessage } from '../types.js';
import type {
  AgentMessageDeltaParams,
  AgentMessageCompletedParams,
  ReasoningDeltaParams,
  ReasoningCompletedParams,
  TurnCompletedParams,
  TurnFailedParams,
  McpToolCallParams,
  CommandExecutionParams,
  ErrorParams,
} from './types.js';

/**
 * Map a JSON-RPC notification to a StreamMessage.
 * Returns null for notifications that should be skipped.
 *
 * @param method - The notification method name
 * @param params - The notification parameters
 * @returns A StreamMessage or null if the notification should be skipped
 */
export function mapNotification(
  method: string,
  params: unknown
): StreamMessage | null {
  switch (method) {
    // ========================================================================
    // Turn lifecycle events
    // ========================================================================

    case 'turn/started':
      // Turn started, no content to yield
      return null;

    case 'turn/completed': {
      const turnParams = params as TurnCompletedParams | undefined;
      // Check if interrupted vs completed
      if (turnParams?.status === 'interrupted') {
        return { type: 'error', error: 'Turn was interrupted' };
      }
      return { type: 'complete' };
    }

    case 'turn/failed': {
      const failParams = params as TurnFailedParams | undefined;
      const errorMessage =
        failParams?.error ?? failParams?.message ?? 'Turn failed';
      return { type: 'error', error: errorMessage };
    }

    // ========================================================================
    // Agent message events (streaming text response)
    // ========================================================================

    case 'item/agentMessage/delta': {
      const deltaParams = params as AgentMessageDeltaParams | undefined;
      if (deltaParams?.delta) {
        return { type: 'text', content: deltaParams.delta };
      }
      return null;
    }

    case 'item/agentMessage/completed': {
      // We already streamed the deltas, so we can skip the completed event
      // But we could emit it if we wanted the full text
      const completedParams = params as AgentMessageCompletedParams | undefined;
      if (completedParams?.text) {
        // Optionally emit full text - but this would duplicate streamed content
        // For now, skip it
      }
      return null;
    }

    // ========================================================================
    // Reasoning events (thinking/chain-of-thought)
    // ========================================================================

    case 'item/reasoning/textDelta': {
      const reasoningParams = params as ReasoningDeltaParams | undefined;
      if (reasoningParams?.delta) {
        return { type: 'thinking', content: reasoningParams.delta };
      }
      return null;
    }

    case 'item/reasoning/completed': {
      // Similar to agentMessage/completed, we already streamed the deltas
      const reasoningParams = params as ReasoningCompletedParams | undefined;
      if (reasoningParams?.text) {
        // Optionally emit full reasoning text
      }
      return null;
    }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/summaryTextCompleted':
      // Reasoning summary events - skip silently
      return null;

    // ========================================================================
    // MCP tool call events
    // ========================================================================

    case 'item/mcpToolCall/started': {
      const mcpParams = params as McpToolCallParams | undefined;
      return {
        type: 'tool_use',
        toolName: mcpParams?.tool ?? 'mcp_tool',
        toolInput: mcpParams?.arguments,
      };
    }

    case 'item/mcpToolCall/completed': {
      const mcpParams = params as McpToolCallParams | undefined;
      if (mcpParams?.error) {
        return {
          type: 'tool_result',
          toolName: mcpParams?.tool ?? 'mcp_tool',
          content: `Error: ${mcpParams.error.message}`,
        };
      }
      return {
        type: 'tool_result',
        toolName: mcpParams?.tool ?? 'mcp_tool',
        content: formatMcpResult(mcpParams),
      };
    }

    case 'item/started':
    case 'item/completed':
      // Generic item lifecycle events - skip silently
      return null;

    // ========================================================================
    // Command execution events (shell commands)
    // ========================================================================

    case 'item/commandExecution/started': {
      const cmdParams = params as CommandExecutionParams | undefined;
      return {
        type: 'tool_use',
        toolName: 'command',
        toolInput: { command: cmdParams?.command },
      };
    }

    case 'item/commandExecution/completed': {
      const cmdParams = params as CommandExecutionParams | undefined;
      return {
        type: 'tool_result',
        toolName: 'command',
        content: formatCommandResult(cmdParams),
      };
    }

    // ========================================================================
    // Error events
    // ========================================================================

    case 'error': {
      const errorParams = params as ErrorParams | undefined;
      return {
        type: 'error',
        error: errorParams?.message ?? 'Unknown error',
      };
    }

    // ========================================================================
    // Unknown/unhandled events
    // ========================================================================

    default:
      // Skip noisy codex internal events
      if (method.startsWith('codex/event/')) {
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
function formatMcpResult(params: McpToolCallParams | undefined): string {
  if (!params?.result) {
    return 'Tool completed';
  }

  // Format the content blocks
  const contentParts = params.result.content
    .map((block) => {
      if (block.text) {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .filter(Boolean);

  if (contentParts.length > 0) {
    return contentParts.join('\n');
  }

  // Fall back to structured content
  if (params.result.structured_content !== undefined) {
    return JSON.stringify(params.result.structured_content, null, 2);
  }

  return 'Tool completed';
}

/**
 * Format command execution result as a string.
 */
function formatCommandResult(params: CommandExecutionParams | undefined): string {
  const parts: string[] = [];

  if (params?.command) {
    parts.push(`$ ${params.command}`);
  }

  if (params?.aggregated_output) {
    parts.push(params.aggregated_output);
  }

  if (params?.exit_code !== undefined && params.exit_code !== 0) {
    parts.push(`[exit code: ${params.exit_code}]`);
  }

  return parts.join('\n') || 'Command completed';
}
