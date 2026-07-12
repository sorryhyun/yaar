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

/** An installed app, as reported by `list('yaar://apps')`. */
export interface InstalledApp {
  id: string;
  name: string;
  description?: string;
}

/**
 * A running app — the join of an app's open windows and its app agent.
 *
 * An app counts as running if it has at least one open window OR a live agent.
 * The two are independent: agents are keyed by appId and persist for the whole
 * session, so an app whose last window was closed keeps its agent (and its
 * context, and its slot against MAX_AGENTS). Those show up here as `orphaned`.
 */
export interface AppProcess {
  appId: string;
  name: string;
  windows: WindowInfo[];
  /** The app's agent, or null if it has never been interacted with. */
  agent: AgentEntry | null;
  /** Has a live agent but no open window — nothing will reclaim it on its own. */
  orphaned: boolean;
}

export type TabId = 'agents' | 'windows' | 'apps';
