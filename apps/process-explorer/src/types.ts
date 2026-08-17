export {};

import type { TAB_IDS } from './constants';

/**
 * Token consumption for one agent (or the whole session).
 *
 * All four fields, and the cache ones are not optional decoration. Both
 * providers report `inputTokens` as the input that was *neither* read from the
 * cache nor used to create one — so under Claude Code's caching it is a
 * near-constant handful of tokens while the bulk rides in `cacheReadTokens`.
 * A measured turn: 10 fresh input against 18,751 cache-read.
 *
 * The displayed input is `inputTokens + cacheWriteTokens` — cache **reads are
 * excluded**. They are the same context re-sent on every turn, so folding them
 * in makes the figure climb with turn count even when the agent takes in nothing
 * new. Cache writes are counted: that content is passing through the model for
 * the first time. `inputRead()` in `format.ts` is the one place that sum is taken;
 * nothing should add these fields by hand.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentStats {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  monitorAgents: number;
  appAgents: number;
  ephemeralAgents: number;
  sessionAgent: boolean;
  /**
   * Every agent's tokens summed, disposed agents included — so it only grows,
   * and exceeds the sum of the rows below by whatever the retired ones spent.
   */
  usage?: AgentUsage;
  agents: AgentEntry[];
}

/**
 * The tier the server assigned an agent.
 *
 * Deliberately open rather than a closed union: the vocabulary is the *server's*
 * to extend, and this app only ever compares against the four it knows (`app`
 * for the process join, `session` for the stream it must not open, `ephemeral`
 * for a badge colour). A fifth tier from a newer server should render as its own
 * name and behave like a monitor agent — not blank the panel.
 */
export type AgentTier = 'session' | 'monitor' | 'app' | 'persona' | 'ephemeral' | (string & {});

export interface AgentEntry {
  /** instanceId — what the interrupt action takes. */
  id: string;
  type: AgentTier;
  /** Human-readable name: the monitorId, the appId, or the current role. */
  label: string;
  busy: boolean;
  monitorId?: string;
  appId?: string;
  /** Lifetime tokens for this agent. Optional — an older server won't send it. */
  usage?: AgentUsage;
}

/**
 * Where an agent's current turn is, derived from its stream's frame kinds.
 *
 * `busy` on the roster only says a turn is in flight. This says what it is doing
 * inside that turn — and, once it ends, *how* it ended, which the roster never
 * reports at all.
 */
export type AgentTurnState = 'responding' | 'using-tool' | 'done' | 'error';

/**
 * Live activity for one agent, folded from its `yaar://agents/{id}/stream` feed.
 *
 * The roster (`yaar://session/agents`) tells us an agent is *busy*; the stream
 * tells us *what* — the tool it is running and a tail of the text it is emitting.
 * Kept small on purpose: a glance, not a transcript.
 *
 * The whole record is replaced on each `start` frame. Turn boundaries are what
 * make that possible: without them the first delta of a new turn is
 * indistinguishable from a continuation of the last one, so text accumulated
 * across turns forever and a stale tool line outlived the call that set it.
 */
export interface AgentActivity {
  /** Where the current turn is. */
  state: AgentTurnState;
  /** The current/last tool call: display name + status. */
  tool?: { name: string; status: string };
  /** Tail of the assistant text streamed this turn (capped). */
  text?: string;
  /** How the turn ended, from the terminal `done` frame. */
  endStatus?: 'completed' | 'interrupted';
  /** Error text from a terminal `error` frame. */
  error?: string;
  /**
   * Lifetime tokens, from `usage` frames — the same figure the roster carries,
   * but arriving as the agent spends them instead of on the next poll. Held here
   * so a row can prefer the live number and fall back to the roster's.
   */
  usage?: AgentUsage;
  /** `frame.ts` of the most recent frame — drives the freshness readout. */
  updatedAt: number;
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

/**
 * One sandbox browser session, as `yaar://system/browsers` reports it.
 *
 * `state` is the field that makes this a process list rather than a tab list: a
 * session is not simply open or closed. `suspended` means the id still names a
 * page and a profile with nobody connected to it — what a reloaded desktop or the
 * idle sweep leaves behind — and reviving it puts a socket back on that page.
 */
export interface BrowserSession {
  /** The `browserId` a window addresses this session by. */
  id: string;
  url: string;
  title: string;
  mobile: boolean;
  /** The YAAR window showing it, when one is. */
  windowId?: string;
  state: 'live' | 'suspended' | 'crashed' | (string & {});
  /** An agent is mid-action on this tab right now. */
  driving: boolean;
  /** Live screencast viewers — 0 means nobody is looking at it. */
  viewers: number;
  createdAt: number;
  idleMs: number;
  /** Page JS heap where Chrome will say. A weight proxy, not an accounting. */
  jsHeapBytes: number | null;
}

/** The views. Derived from TAB_IDS so the tab order and the type cannot drift. */
export type TabId = (typeof TAB_IDS)[number];

/**
 * The payload of a stream frame, as far as this app reads it.
 *
 * Every field is optional and none is validated: frames arrive many times a
 * second from our own server, so this is a named shape for a single narrow cast
 * at the fold site rather than a trust boundary worth a Zod parse. The folder
 * defaults each field it reads.
 */
export interface AgentFrameData {
  /** `text` frames: the chunk of assistant text just emitted. */
  delta?: string;
  /** `tool` frames: display name of the tool being called. */
  toolName?: string;
  /** `tool` frames: 'running' etc. On a `done` frame: 'interrupted' etc. */
  status?: string;
  /** `error` frames: the message to surface on the row. */
  error?: string;
  /** `usage` frames: cumulative lifetime totals for the agent, not turn deltas. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
