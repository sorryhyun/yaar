import type { OSAction } from '@yaar/shared';
import type { ContextSource } from '../agents/context.js';
import type { EscapeGuardRecord } from '../providers/types.js';
import type { BlobRef } from './blobs.js';

export interface AgentInfo {
  agentId: string;
  parentAgentId: string | null;
  windowId?: string;
  createdAt: string;
}

export interface SessionMetadata {
  createdAt: string;
  provider: string;
  lastActivity: string;
  agents: Record<string, AgentInfo>; // agentId -> AgentInfo
  threadIds?: Record<string, string>; // canonicalAgent -> provider threadId
  failureCount?: number;
  /**
   * Pid of the server process that created this log. Read only by
   * `pruneEmptySessions()`, to tell a log abandoned by a dead server from one a
   * still-running instance is holding open. Absent in logs from older builds.
   */
  pid?: number;
}

export interface SessionInfo {
  sessionId: string;
  directory: string;
  metadata: SessionMetadata;
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
    | 'escape_guard';
  timestamp: string;
  agentId: string | null;
  parentAgentId: string | null;
  source?: ContextSource;
  // Natural-language messages (user/assistant/thinking) are strings; tool_result
  // content may be revived JSON (object/array) — see reviveJson in session-logger.
  content?: unknown;
  /**
   * Set instead of `content` when the result was too large to inline: the bytes live in
   * the session's blob store, readable at `yaar://history/{id}/blobs/{sha256}`. Exactly
   * one of `content` / `contentRef` is present on a result entry. See logging/blobs.ts.
   */
  contentRef?: BlobRef;
  action?: OSAction;
  toolName?: string;
  toolInput?: unknown;
  // How the raw argument JSON spelled its text (Claude provider only):
  // unicodeEscapes = \uXXXX spellings normalized away by parse (harmless),
  // literalBackslashU = backslash-u text surviving in the parsed value (corrupting).
  toolInputEscapes?: { unicodeEscapes: number; literalBackslashU: number };
  /**
   * An escape guard firing, with the text that triggered it. On a `tripwire`
   * entry there is deliberately no accompanying `tool_use` entry — the call was
   * cancelled before it ran, so this is the only trace of it.
   */
  escapeGuard?: EscapeGuardRecord;
  toolUseId?: string;
  interactionSource?: string;
  interaction?: string;
  // Written on result entries by `logToolResult` / `logVerbResult`. Declared here
  // because they were already being logged and read back untyped.
  isError?: boolean;
  errorCategory?: string;
  durationMs?: number;
}
