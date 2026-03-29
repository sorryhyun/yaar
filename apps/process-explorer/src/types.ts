export {};

export interface AgentStats {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  monitorAgent: string[];
  appAgents: number;
  ephemeralAgents: string[];
  sessionAgent?: { exists: boolean; busy: boolean };
}

export interface AgentEntry {
  id: string;
  type: 'monitor' | 'app' | 'ephemeral' | 'session';
  busy?: boolean;
}

export interface WindowInfo {
  id: string;
  uri: string;
  title: string;
  position: string;
  size: string;
  renderer: string;
  locked: boolean;
  lockedBy?: string;
  appId?: string;
}

export interface BrowserTab {
  id: string;
  uri: string;
  url: string;
  title: string;
}

export type TabId = 'agents' | 'windows' | 'browsers';
