export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  provider: string;
  lastActivity: string;
  agentCount: number;
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
    | 'interaction';
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
}
