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

export interface ParsedMessage {
  type: 'user' | 'assistant' | 'action' | 'thinking' | 'tool_use' | 'tool_result' | 'interaction';
  timestamp: string;
  agentId: string | null;
  parentAgentId?: string | null;
  source?: string;
  content?: string;
  action?: Record<string, unknown>;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  interaction?: string;
}
