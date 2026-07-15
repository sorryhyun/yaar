import type { OSAction } from '@yaar/shared';
import type { ContextSource } from '../agents/context.js';

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
}

export interface SessionInfo {
  sessionId: string;
  directory: string;
  metadata: SessionMetadata;
}

export interface ParsedMessage {
  type: 'user' | 'assistant' | 'action' | 'thinking' | 'tool_use' | 'tool_result' | 'interaction';
  timestamp: string;
  agentId: string | null;
  parentAgentId: string | null;
  source?: ContextSource;
  // Natural-language messages (user/assistant/thinking) are strings; tool_result
  // content may be revived JSON (object/array) — see reviveJson in session-logger.
  content?: unknown;
  action?: OSAction;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  interactionSource?: string;
  interaction?: string;
}
