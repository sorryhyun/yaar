/**
 * Codex app-server types.
 *
 * Domain-specific types are generated from the Codex schema via
 * `make codex-types` (see packages/server/src/providers/codex/generated/).
 * This file re-exports generated types and provides JSON-RPC base plumbing.
 */

// ============================================================================
// Re-exports from generated schema
// ============================================================================

// Protocol unions
export type { ServerRequest as CodexServerRequest } from './generated/index.js';
export type { ServerNotification as CodexServerNotification } from './generated/index.js';
export type { ClientRequest as CodexClientRequest } from './generated/index.js';

// Approval types
export type { ReviewDecision } from './generated/index.js';
export type { ExecCommandApprovalParams } from './generated/index.js';
export type { ExecCommandApprovalResponse } from './generated/index.js';
export type { ApplyPatchApprovalParams } from './generated/index.js';
export type { ApplyPatchApprovalResponse } from './generated/index.js';

// Initialize
export type { InitializeParams } from './generated/index.js';
export type { InitializeResponse } from './generated/index.js';
export type { InitializeCapabilities } from './generated/index.js';
export type { ClientInfo as CodexClientInfo } from './generated/index.js';

// Thread/Turn request & response types (v2 API)
export type { ThreadStartParams } from './generated/v2/index.js';
export type { ThreadStartResponse } from './generated/v2/index.js';
export type { ThreadResumeParams } from './generated/v2/index.js';
export type { ThreadResumeResponse } from './generated/v2/index.js';
export type { ThreadForkParams } from './generated/v2/index.js';
export type { ThreadForkResponse } from './generated/v2/index.js';
export type { TurnStartParams } from './generated/v2/index.js';
export type { TurnStartResponse } from './generated/v2/index.js';
export type { TurnInterruptParams } from './generated/v2/index.js';
export type { TurnInterruptResponse } from './generated/v2/index.js';
export type { TurnSteerParams } from './generated/v2/index.js';
export type { TurnSteerResponse } from './generated/v2/index.js';
export type { UserInput } from './generated/v2/index.js';
export type { Thread } from './generated/v2/index.js';
export type { Turn } from './generated/v2/index.js';
export type { TurnStatus } from './generated/v2/index.js';
export type { TurnError } from './generated/v2/index.js';
export type { ThreadItem } from './generated/v2/index.js';

// Approval types (v2 API)
export type { CommandExecutionRequestApprovalParams } from './generated/v2/index.js';
export type { CommandExecutionRequestApprovalResponse } from './generated/v2/index.js';
export type { CommandExecutionApprovalDecision } from './generated/v2/index.js';
export type { FileChangeRequestApprovalParams } from './generated/v2/index.js';
export type { FileChangeRequestApprovalResponse } from './generated/v2/index.js';
export type { FileChangeApprovalDecision } from './generated/v2/index.js';

// Notification types (v2 API)
export type { AgentMessageDeltaNotification } from './generated/v2/index.js';
export type { ReasoningTextDeltaNotification } from './generated/v2/index.js';
export type { TurnCompletedNotification } from './generated/v2/index.js';
export type { TurnStartedNotification } from './generated/v2/index.js';
export type { ErrorNotification } from './generated/v2/index.js';
export type { ItemStartedNotification } from './generated/v2/index.js';
export type { ItemCompletedNotification } from './generated/v2/index.js';

// Account/Auth types (v2 API)
export type { GetAccountParams } from './generated/v2/index.js';
export type { GetAccountResponse } from './generated/v2/index.js';
export type { LoginAccountParams } from './generated/v2/index.js';
export type { LoginAccountResponse } from './generated/v2/index.js';
export type { CancelLoginAccountParams } from './generated/v2/index.js';
export type { CancelLoginAccountResponse } from './generated/v2/index.js';
export type { AccountLoginCompletedNotification } from './generated/v2/index.js';
export type { Account } from './generated/v2/index.js';

// Event message (v1 events union) and collaboration/subagent event types
export type { EventMsg } from './generated/EventMsg.js';
export type { AgentStatus } from './generated/AgentStatus.js';
export type { CollabAgentSpawnBeginEvent } from './generated/CollabAgentSpawnBeginEvent.js';
export type { CollabAgentSpawnEndEvent } from './generated/CollabAgentSpawnEndEvent.js';
export type { CollabAgentInteractionBeginEvent } from './generated/CollabAgentInteractionBeginEvent.js';
export type { CollabAgentInteractionEndEvent } from './generated/CollabAgentInteractionEndEvent.js';
export type { CollabWaitingBeginEvent } from './generated/CollabWaitingBeginEvent.js';
export type { CollabWaitingEndEvent } from './generated/CollabWaitingEndEvent.js';
export type { CollabCloseBeginEvent } from './generated/CollabCloseBeginEvent.js';
export type { CollabCloseEndEvent } from './generated/CollabCloseEndEvent.js';
export type { CollabResumeBeginEvent } from './generated/CollabResumeBeginEvent.js';
export type { CollabResumeEndEvent } from './generated/CollabResumeEndEvent.js';
export type { WebSearchBeginEvent } from './generated/WebSearchBeginEvent.js';
export type { WebSearchEndEvent } from './generated/WebSearchEndEvent.js';

// ============================================================================
// JSON-RPC Base Types (protocol plumbing, not generated)
// ============================================================================

/**
 * Base JSON-RPC request structure.
 */
export interface JsonRpcRequest<T = unknown> {
  jsonrpc?: '2.0';
  method: string;
  params?: T;
  id: number;
}

/**
 * JSON-RPC response (success case).
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc?: '2.0';
  result: T;
  id: number;
}

/**
 * JSON-RPC error response.
 */
export interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: number;
}

/**
 * JSON-RPC notification (no id field, no response expected).
 */
export interface JsonRpcNotification<T = unknown> {
  jsonrpc?: '2.0';
  method: string;
  params?: T;
}

/**
 * JSON-RPC server-initiated request (has both id and method).
 * The server sends these when it needs a response from the client.
 */
export interface JsonRpcServerRequest<T = unknown> {
  jsonrpc?: '2.0';
  method: string;
  params?: T;
  id: number;
}

/**
 * Union type for any JSON-RPC message from the server.
 */
export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Check if a JSON-RPC message is an error response.
 */
export function isErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return 'error' in message;
}

/**
 * Check if a JSON-RPC message is a server-initiated request (has both id and method).
 */
export function isServerRequest(message: JsonRpcMessage): message is JsonRpcServerRequest {
  return 'id' in message && message.id !== undefined && 'method' in message;
}

/**
 * Check if a JSON-RPC message is a notification (no id).
 */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) || message.id === undefined;
}

/**
 * Check if a JSON-RPC message is a response (has id, no method).
 */
export function isResponse(
  message: JsonRpcMessage,
): message is JsonRpcResponse | JsonRpcErrorResponse {
  return 'id' in message && message.id !== undefined && !('method' in message);
}
