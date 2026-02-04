import type { OSAction } from '@yaar/shared';

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
}

export interface SessionInfo {
  sessionId: string;
  directory: string;
  metadata: SessionMetadata;
}

export interface ParsedMessage {
  type: 'user' | 'assistant' | 'action' | 'thinking' | 'tool_use' | 'tool_result';
  timestamp: string;
  agentId: string;
  parentAgentId: string | null;
  content?: string;
  action?: OSAction;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}
