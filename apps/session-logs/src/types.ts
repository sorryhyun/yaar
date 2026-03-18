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
