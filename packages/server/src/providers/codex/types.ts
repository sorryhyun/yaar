/**
 * JSON-RPC types for Codex app-server communication.
 *
 * The app-server uses JSON-RPC 2.0 over stdio for all communication.
 * Requests have an `id` field; notifications do not.
 */

// ============================================================================
// JSON-RPC Base Types
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
 * Union type for any JSON-RPC message from the server.
 */
export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

// ============================================================================
// Thread/Turn Request & Response Types
// ============================================================================

/**
 * Parameters for thread/start request.
 */
export interface ThreadStartParams {
  /** System prompt / base instructions for this thread */
  baseInstructions?: string;
}

/**
 * Thread object returned from the app-server.
 */
export interface Thread {
  id: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  path?: string;
  cwd?: string;
  cliVersion?: string;
  source?: string;
  turns?: unknown[];
}

/**
 * Response from thread/start request.
 */
export interface ThreadStartResult {
  thread: Thread;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: unknown;
  reasoningEffort?: string;
}

/**
 * Parameters for initialize request.
 */
export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
}

/**
 * Response from initialize request.
 */
export interface InitializeResult {
  userAgent: string;
}

/**
 * Parameters for thread/resume request.
 */
export interface ThreadResumeParams {
  threadId: string;
}

/**
 * Parameters for thread/fork request.
 * Branches an existing thread into a new independent thread.
 */
export interface ThreadForkParams {
  threadId: string;
}

/**
 * Response from thread/fork request.
 */
export interface ThreadForkResult {
  thread: Thread;
}

/**
 * Parameters for turn/start request.
 */
export interface TurnStartParams {
  threadId: string;
  input: TurnInput[];
}

/**
 * Input item for a turn (text or image).
 */
export type TurnInput = TextInput | ImageInput;

export interface TextInput {
  type: 'text';
  text: string;
}

export interface ImageInput {
  type: 'image';
  url: string;
}

// ============================================================================
// Notification Types (streamed during a turn)
// ============================================================================

/**
 * Notification methods we handle from the app-server.
 */
export type NotificationMethod =
  | 'turn/started'
  | 'turn/completed'
  | 'turn/failed'
  | 'item/agentMessage/delta'
  | 'item/agentMessage/completed'
  | 'item/reasoning/textDelta'
  | 'item/reasoning/completed'
  | 'item/mcpToolCall/started'
  | 'item/mcpToolCall/completed'
  | 'item/commandExecution/started'
  | 'item/commandExecution/completed'
  | 'error';

/**
 * Parameters for item/agentMessage/delta notification.
 */
export interface AgentMessageDeltaParams {
  delta: string;
}

/**
 * Parameters for item/agentMessage/completed notification.
 */
export interface AgentMessageCompletedParams {
  text: string;
}

/**
 * Parameters for item/reasoning/textDelta notification.
 */
export interface ReasoningDeltaParams {
  delta: string;
}

/**
 * Parameters for item/reasoning/completed notification.
 */
export interface ReasoningCompletedParams {
  text: string;
}

/**
 * Parameters for turn/completed notification.
 */
export interface TurnCompletedParams {
  status: 'completed' | 'interrupted';
}

/**
 * Parameters for turn/failed notification.
 */
export interface TurnFailedParams {
  error?: string;
  message?: string;
}

/**
 * Parameters for MCP tool call notifications.
 */
export interface McpToolCallParams {
  tool?: string;
  server?: string;
  arguments?: Record<string, unknown>;
  result?: {
    content: Array<{ type: string; text?: string }>;
    structured_content?: unknown;
  };
  error?: {
    message: string;
  };
}

/**
 * Parameters for command execution notifications.
 */
export interface CommandExecutionParams {
  command?: string;
  exit_code?: number;
  aggregated_output?: string;
}

/**
 * Parameters for error notification.
 */
export interface ErrorParams {
  message: string;
  code?: string;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Check if a JSON-RPC message is an error response.
 */
export function isErrorResponse(
  message: JsonRpcMessage
): message is JsonRpcErrorResponse {
  return 'error' in message;
}

/**
 * Check if a JSON-RPC message is a notification (no id).
 */
export function isNotification(
  message: JsonRpcMessage
): message is JsonRpcNotification {
  return !('id' in message) || message.id === undefined;
}

/**
 * Check if a JSON-RPC message is a response (has id).
 */
export function isResponse(
  message: JsonRpcMessage
): message is JsonRpcResponse | JsonRpcErrorResponse {
  return 'id' in message && message.id !== undefined;
}
