export {};

export interface AgentStats {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  monitorAgents: number;
  appAgents: number;
  ephemeralAgents: number;
  sessionAgent: boolean;
  agents: AgentEntry[];
}

export interface AgentEntry {
  /** instanceId — what the interrupt action takes. */
  id: string;
  type: 'session' | 'monitor' | 'app' | 'ephemeral';
  /** Human-readable name: the monitorId, the appId, or the current role. */
  label: string;
  busy: boolean;
  monitorId?: string;
  appId?: string;
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
