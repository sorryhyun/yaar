export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  provider: string;
  lastActivity: string;
  agentCount: number;
  /** Session meta, when the list read carries it — the monitor badge reads both. */
  threadIds?: unknown;
  agents?: unknown;
  /**
   * Every monitor the session ran, and every context reset. Together they split the log
   * into its conversations (`conversations.ts`). Absent from older servers.
   */
  monitors?: string[];
  resets?: ResetRecord[];
}

/** One context reset: when, and which monitors started a new conversation there. */
export interface ResetRecord {
  at: string;
  monitorIds: string[];
}

export interface SessionDetail {
  sessionId: string;
  createdAt: string;
  provider: string;
  lastActivity: string;
  agentCount?: number;
  [key: string]: unknown;
}

/**
 * A result too large to inline. The bytes live in the session's blob store, readable at
 * `yaar://history/{id}/blobs/{sha256}` — see packages/server/src/logging/blobs.ts.
 */
export interface BlobRef {
  sha256: string;
  bytes: number;
  mimeType?: string;
  preview?: string;
}

export interface ParsedMessage {
  type:
    | 'user'
    | 'assistant'
    | 'action'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'verb_result'
    | 'interaction'
    | 'reset';
  timestamp: string;
  agentId: string | null;
  parentAgentId?: string | null;
  source?: string;
  content?: string;
  /** Set instead of `content` when the result was offloaded. Exactly one is present. */
  contentRef?: BlobRef;
  action?: Record<string, unknown>;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  interaction?: string;
  isError?: boolean;
  durationMs?: number;
  /**
   * Written by the server on agent-less rows (iframe verb calls, user interactions): the
   * window the row came from and the monitor it happened on. Absent in older logs.
   */
  windowId?: string;
  monitorId?: string;
  /** Prior-thread history copied in when a thread was resumed — not this session's work. */
  restored?: boolean;
  /** Monitor id ('0', '1', …) or 'unknown'; set by `annotateMonitors` at load. */
  monitor?: string;
  /** On a `reset` entry: the monitors that start a new conversation here. */
  monitorIds?: string[];
  /** Which of its monitor's conversations this turn is in; set by `annotateEpochs` at load. */
  epoch?: number;
}
