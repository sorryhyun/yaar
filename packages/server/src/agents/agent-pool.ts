/**
 * AgentPool - manages agents with role-based lifecycle.
 *
 * Agent types:
 * - Monitor agents: persistent per-monitor, handle USER_MESSAGE, provider session continuity
 * - Ephemeral agents: fresh provider, no context, disposed after one task
 * - App agents: persistent per (monitor, app), handle app protocol communication
 * - Persona agents: N per (monitor, app), tool-less, prompt supplied by the app at runtime
 *
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './agent-session.js';
import { getAgentLimiter } from './limiter.js';
import { personaRole } from './profiles/persona.js';
import { monitorSource } from './context.js';
import { acquireWarmProvider } from '../providers/factory.js';
import { getSessionHub } from '../session/session-hub.js';
import { notifyAgentsChanged } from '../http/subscriptions.js';
import type { ServerEvent } from '@yaar/shared';
import type { SessionId } from '../session/types.js';
import type { SessionLogger } from '../logging/index.js';
import type { AITransport, TokenUsage } from '../providers/types.js';
import type { AgentRole } from './agent-context.js';
import type { AgentPoolStats } from './pool-types.js';

/**
 * App agents are scoped to the monitor that owns their windows, so two monitors
 * running the same app each get their own agent (and neither can see the other's
 * context). This is the composite key; `::` cannot occur in a monitorId (numeric)
 * or an appId (a directory name).
 */
export function appAgentKey(monitorId: string, appId: string): string {
  return `${monitorId}::${appId}`;
}
const appKey = appAgentKey;

function parseAppKey(key: string): { monitorId: string; appId: string } {
  const idx = key.indexOf('::');
  return { monitorId: key.slice(0, idx), appId: key.slice(idx + 2) };
}

/**
 * Persona agents extend the app key with the persona's own id. The parts are never
 * parsed back out — {@link PersonaAgent} carries them as fields — so the key only
 * has to be unique, and `::` still cannot occur in any of the three components
 * (numeric monitorId, directory-name appId, {@link PERSONA_ID_RE} personaId).
 */
export function personaAgentKey(monitorId: string, appId: string, personaId: string): string {
  return `${monitorId}::${appId}::${personaId}`;
}

/**
 * Internal pooled agent representation.
 */
export interface PooledAgent {
  session: AgentSession;
  id: number;
  instanceId: string;
  lastUsed: number;
  currentRole: string | null; // 'monitor-{messageId}' or 'app-{id}' when active
  idleTimer: NodeJS.Timeout | null;
}

/** One live agent, as reported by `listAgents()`. */
export interface AgentEntry {
  /** instanceId — stable across turns; accepted by `interruptByIdOrRole`. */
  id: string;
  type: 'session' | 'monitor' | 'app' | 'ephemeral' | 'persona';
  /** Human-readable name: the monitorId, the appId, or the current role. */
  label: string;
  busy: boolean;
  monitorId?: string;
  appId?: string;
  /** Persona agents only — the id its owning app spawned it under. */
  personaId?: string;
  /** Lifetime token consumption. `inputTokens` is fresh input — see {@link TokenUsage}. */
  usage: TokenUsage;
}

/**
 * A persona agent and the metadata its owning app spawned it with.
 *
 * The prompt lives here rather than on the provider because a persona's prompt is
 * *the persona*: it is replayed as `systemPromptOverride` on every turn, and the
 * provider's own `systemPrompt` (the generic YAAR one it was warmed with) is never
 * used. Keeping it on the record also means a busy check, a roster row, and a
 * respawn all read the same object.
 */
export interface PersonaAgent {
  agent: PooledAgent;
  monitorId: string;
  appId: string;
  personaId: string;
  /** Verbatim, caller-supplied. Replayed on every turn — see {@link buildPersonaProfile}. */
  systemPrompt: string;
  model?: string;
  createdAt: number;
  /**
   * Final assistant text of the last completed turn.
   *
   * The `done` stream frame carries the same text, so a live subscriber never needs
   * this. It exists for the subscriber that *wasn't* live: an iframe that reloaded
   * mid-turn, or one whose subscription dropped, can `read` the persona and recover
   * the answer instead of re-asking a question the model already paid for.
   */
  lastResponse?: string;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}

export class AgentPool {
  private sessionId: SessionId;
  private nextAgentId = 0;
  private logger: SessionLogger | null = null;
  private broadcastFn: (event: ServerEvent) => void;
  private resolveWindowHandle: (rawId: string, monitorId?: string) => string;

  /** Persistent monitor agents, keyed by monitorId. */
  private monitorAgents = new Map<string, PooledAgent>();

  /** Persistent per-app agents, keyed by `{monitorId}::{appId}` (see `appKey`). */
  private appAgents = new Map<string, PooledAgent>();

  /**
   * Persona agents, keyed by `{monitorId}::{appId}::{personaId}` (see `personaAgentKey`).
   *
   * Monitor-scoped for the same reason app agents are: the app that spawned them is
   * itself scoped to the monitor whose window it runs in, so two monitors running the
   * same app get two independent casts and neither can name the other's.
   */
  private personaAgents = new Map<string, PersonaAgent>();

  /** Session agent — lazy singleton for cross-monitor oversight. */
  private sessionAgent: PooledAgent | null = null;

  /**
   * The monitor the session agent is running its current turn on.
   *
   * The session agent lives in no monitor collection, so `findMonitorForAgent` used to
   * answer `undefined` for it — and the MCP request context, which scopes every window
   * lookup by that answer, fell to monitor 0, while the emitter stamped the outbound
   * event with the session's "active" monitor. One turn, two monitors: the window was
   * registered on one and delivered to the other. It runs on a monitor like every other
   * agent — the one the user spoke from — so it says which, for the length of the turn.
   */
  private sessionAgentMonitorId: string | undefined;

  /** Pin the session agent to the monitor of the turn it is about to run. */
  setSessionAgentMonitor(monitorId: string | undefined): void {
    this.sessionAgentMonitorId = monitorId;
  }

  /** Ephemeral agents currently in-flight (disposed after task). */
  private ephemeralAgents = new Set<PooledAgent>();

  /** All agent instanceIds for O(1) lookup. */
  private agentIds = new Set<string>();

  /**
   * Tokens spent by agents that no longer exist.
   *
   * Ephemeral agents are disposed the moment their task ends, and app agents can
   * be deleted outright — without this, the session total would *shrink* as work
   * completed, which reads as a bug in the counter rather than the truth about
   * where the tokens went. Folded at the single dispose chokepoint.
   */
  private retiredUsage: TokenUsage = ZERO_USAGE;

  /**
   * Where this pool's agents get their providers. Defaults to the global warm pool.
   *
   * A seam, not a setting: it is the one thing a test must replace to run a real agent
   * turn, and replacing it by name (`mock.module('../providers/factory.js')`) is
   * process-global in Bun and never restored — so one file's stub silently answers
   * another file's `acquireWarmProvider()` for the rest of the run. Injecting it makes
   * the substitution scoped to the pool that asked for it.
   */
  private readonly acquireProvider: () => Promise<AITransport | null>;

  constructor(
    sessionId: SessionId,
    broadcast: (event: ServerEvent) => void,
    resolveWindowHandle?: (rawId: string, monitorId?: string) => string,
    acquireProvider?: () => Promise<AITransport | null>,
  ) {
    this.sessionId = sessionId;
    this.broadcastFn = broadcast;
    this.resolveWindowHandle = resolveWindowHandle ?? ((id) => id);
    this.acquireProvider = acquireProvider ?? acquireWarmProvider;
  }

  setLogger(logger: SessionLogger): void {
    this.logger = logger;
  }

  // ── Roster tracking ──────────────────────────────────────────────────
  //
  // Every agent that exists is in `agentIds`, so adding and removing there is
  // the one place that knows the roster changed. Both notify subscribers of
  // yaar://session/agents (Process Explorer watches it instead of polling).

  private trackAgent(instanceId: string): void {
    this.agentIds.add(instanceId);
    getSessionHub().registerAgent(instanceId, this.sessionId);
    notifyAgentsChanged(this.sessionId);
  }

  private untrackAgent(instanceId: string): void {
    this.agentIds.delete(instanceId);
    getSessionHub().unregisterAgent(instanceId);
    notifyAgentsChanged(this.sessionId);
  }

  // ── Iteration ────────────────────────────────────────────────────────

  /**
   * Every live agent, exactly once, in the order every caller here reads them:
   * session → monitor → app → persona → ephemeral. `listAgents()` and `getStats()`
   * expose that order, so it is part of the contract, not an implementation detail.
   *
   * The single traversal is the point: a new agent tier is added here and every
   * roster, lookup, and teardown below sees it. They used to walk the four
   * collections by hand, and a tier missed in one of them is a silent bug.
   */
  private *allAgents(): Iterable<{
    agent: PooledAgent;
    type: AgentEntry['type'];
    monitorId?: string;
    appId?: string;
    personaId?: string;
  }> {
    if (this.sessionAgent) yield { agent: this.sessionAgent, type: 'session' };
    for (const [monitorId, agent] of this.monitorAgents) {
      yield { agent, type: 'monitor', monitorId };
    }
    for (const [key, agent] of this.appAgents) {
      yield { agent, type: 'app', ...parseAppKey(key) };
    }
    for (const p of this.personaAgents.values()) {
      yield {
        agent: p.agent,
        type: 'persona',
        monitorId: p.monitorId,
        appId: p.appId,
        personaId: p.personaId,
      };
    }
    for (const agent of this.ephemeralAgents) yield { agent, type: 'ephemeral' };
  }

  /** An agent is busy while its provider is streaming or a role is assigned to it. */
  private isBusy(agent: PooledAgent): boolean {
    return agent.session.isRunning() || agent.currentRole !== null;
  }

  // ── Agent disposal ───────────────────────────────────────────────────

  /**
   * Tear one agent down, after its owner has already removed it from whichever
   * collection held it. `label` is the log line's subject ("Session agent disposed").
   *
   * `interruptIfRunning` is false for exactly one caller — `disposeEphemeral`, which
   * runs after its one task has finished and never interrupted. Cleanup is allowed to
   * throw through to the caller; the limiter slot is released either way.
   */
  private async disposeAgent(
    agent: PooledAgent,
    label: string,
    { interruptIfRunning = true }: { interruptIfRunning?: boolean } = {},
  ): Promise<void> {
    this.untrackAgent(agent.instanceId);
    // Before cleanup: the agent's counter goes away with it.
    this.retiredUsage = addUsage(this.retiredUsage, agent.session.getUsage());
    if (interruptIfRunning && agent.session.isRunning()) {
      await agent.session.interrupt();
    }
    try {
      await agent.session.cleanup();
    } finally {
      getAgentLimiter().release();
    }
    console.log(`[AgentPool] ${label}: ${agent.instanceId}`);
  }

  // ── Agent creation ───────────────────────────────────────────────────

  /**
   * Create a new agent session with a provider.
   * Does NOT add it to any tracked collection — caller must manage lifecycle.
   */
  private async createAgentCore(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
    const limiter = getAgentLimiter();
    if (!limiter.tryAcquire()) {
      console.log('[AgentPool] Global agent limit reached');
      return null;
    }

    const id = this.nextAgentId++;
    const instanceId = `agent-${id}-${Date.now()}`;

    const session = new AgentSession(
      this.sessionId, // connectionId (legacy, used as fallback)
      undefined,
      this.logger ?? undefined,
      instanceId,
      this.sessionId, // liveSessionId for session-scoped broadcasting
      this.broadcastFn,
      this.resolveWindowHandle,
    );

    const initialized = await session.initialize(preWarmedProvider);
    if (!initialized) {
      limiter.release();
      return null;
    }

    const agent: PooledAgent = {
      session,
      id,
      instanceId,
      lastUsed: Date.now(),
      currentRole: null,
      idleTimer: null,
    };

    this.trackAgent(instanceId);

    console.log(`[AgentPool] Created agent ${id} (${instanceId})`);
    return agent;
  }

  /**
   * Create a monitor agent for the given monitor with the given provider.
   */
  async createMonitorAgent(
    monitorId = '0',
    preWarmedProvider?: AITransport,
  ): Promise<PooledAgent | null> {
    const agent = await this.createAgentCore(preWarmedProvider);
    if (agent) {
      this.monitorAgents.set(monitorId, agent);
      console.log(`[AgentPool] Monitor agent created for ${monitorId}: ${agent.instanceId}`);
    }
    return agent;
  }

  /**
   * Create an ephemeral agent with a fresh provider.
   * The caller is responsible for calling disposeEphemeral() after the task.
   */
  async createEphemeral(): Promise<PooledAgent | null> {
    const provider = await this.acquireProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }
    this.ephemeralAgents.add(agent);
    console.log(`[AgentPool] Ephemeral agent created: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Dispose an ephemeral agent after its task completes.
   */
  async disposeEphemeral(agent: PooledAgent): Promise<void> {
    this.ephemeralAgents.delete(agent);
    await this.disposeAgent(agent, 'Ephemeral agent disposed', { interruptIfRunning: false });
  }

  // ── Monitor agent ─────────────────────────────────────────────────────

  /**
   * Get the monitor agent for a monitor.
   */
  getMonitorAgent(monitorId = '0'): PooledAgent | null {
    return this.monitorAgents.get(monitorId) ?? null;
  }

  /**
   * Check if the monitor agent for a monitor is currently busy.
   */
  isMonitorAgentBusy(monitorId = '0'): boolean {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent) return true; // no monitor agent = effectively busy
    return this.isBusy(agent);
  }

  /**
   * Get the monitor agent's session for a monitor.
   */
  getMonitorAgentSession(monitorId = '0'): AgentSession | null {
    return this.monitorAgents.get(monitorId)?.session ?? null;
  }

  /**
   * Check if a monitor agent exists for the given monitor.
   */
  hasMonitorAgent(monitorId: string): boolean {
    return this.monitorAgents.has(monitorId);
  }

  /**
   * Return the number of active monitor agents (one per monitor).
   */
  getMonitorAgentCount(): number {
    return this.monitorAgents.size;
  }

  /**
   * Return the monitor IDs that have monitor agents.
   */
  getMonitorAgentIds(): string[] {
    return [...this.monitorAgents.keys()];
  }

  /**
   * Remove and dispose the monitor agent for a given monitor.
   * Releases the limiter slot. Returns true if an agent was removed.
   */
  async removeMonitorAgent(monitorId: string): Promise<boolean> {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent) return false;

    // The monitor's app agents die with it — they exist to drive its windows.
    await this.disposeAppAgentsForMonitor(monitorId);

    this.monitorAgents.delete(monitorId);
    await this.disposeAgent(agent, `Monitor agent removed for ${monitorId}`);
    return true;
  }

  // ── App agents ───────────────────────────────────────────────────

  /**
   * Get or create a persistent app agent for one app on one monitor.
   * First call for a (monitorId, appId) pair creates a fresh agent; subsequent
   * calls reuse it. A second monitor opening the same app gets its own agent.
   */
  async getOrCreateAppAgent(monitorId: string, appId: string): Promise<PooledAgent | null> {
    const key = appKey(monitorId, appId);
    const existing = this.appAgents.get(key);
    if (existing) {
      console.log(
        `[AgentPool] Reusing app agent for ${appId} on monitor ${monitorId}: ${existing.instanceId}`,
      );
      return existing;
    }

    const provider = await this.acquireProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    this.appAgents.set(key, agent);
    console.log(
      `[AgentPool] App agent created for ${appId} on monitor ${monitorId}: ${agent.instanceId}`,
    );
    return agent;
  }

  /**
   * Get the app agent for a given app on a given monitor (if it exists).
   */
  getAppAgent(monitorId: string, appId: string): PooledAgent | undefined {
    return this.appAgents.get(appKey(monitorId, appId));
  }

  /**
   * Check if an app agent exists for the given app on the given monitor.
   */
  hasAppAgent(monitorId: string, appId: string): boolean {
    return this.appAgents.has(appKey(monitorId, appId));
  }

  /**
   * Get the count of active app agents.
   */
  getAppAgentCount(): number {
    return this.appAgents.size;
  }

  /**
   * Dispose the app agent for a given app on a given monitor.
   */
  async disposeAppAgent(monitorId: string, appId: string): Promise<void> {
    const key = appKey(monitorId, appId);
    const agent = this.appAgents.get(key);
    if (!agent) return;

    this.appAgents.delete(key);
    await this.disposeAgent(agent, `App agent disposed for ${appId} on monitor ${monitorId}`);
  }

  /**
   * Dispose every app agent owned by a monitor. App agents belong to the monitor
   * whose windows they drive, so tearing the monitor down reclaims them — nothing
   * else would, and leaking them would hold limiter slots for a monitor that's gone.
   */
  async disposeAppAgentsForMonitor(monitorId: string): Promise<void> {
    const appIds = [...this.appAgents.keys()]
      .map(parseAppKey)
      .filter((k) => k.monitorId === monitorId)
      .map((k) => k.appId);

    for (const appId of appIds) {
      await this.disposeAppAgent(monitorId, appId);
    }

    // Not folded into the loop above: a persona is spawned by an app's *iframe*,
    // which needs no app agent to exist. An app that only ever talks to its personas
    // has entries here and none in `appAgents`, so walking app agents would reclaim
    // nothing and leak every slot the monitor's personas hold.
    await this.disposePersonasForMonitor(monitorId);
  }

  // ── Persona agents ───────────────────────────────────────────────

  /**
   * Spawn a persona agent for one app on one monitor.
   *
   * Returns null when the global limiter has no slot — the caller surfaces that to
   * the app as a clean "agent limit reached" rather than a crash, since a room of
   * four characters plus the standing session/monitor/app trio sits close to the
   * `MAX_AGENTS` default. The per-app cap (`personas.max` in app.json) is checked by
   * the caller, which is the layer that can read the manifest.
   */
  async spawnPersonaAgent(
    monitorId: string,
    appId: string,
    personaId: string,
    options: { systemPrompt: string; model?: string },
  ): Promise<PersonaAgent | null> {
    const provider = await this.acquireProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    const record: PersonaAgent = {
      agent,
      monitorId,
      appId,
      personaId,
      systemPrompt: options.systemPrompt,
      ...(options.model ? { model: options.model } : {}),
      createdAt: Date.now(),
    };
    this.personaAgents.set(personaAgentKey(monitorId, appId, personaId), record);
    console.log(
      `[AgentPool] Persona "${personaId}" spawned for ${appId} on monitor ${monitorId}: ${agent.instanceId}`,
    );
    return record;
  }

  getPersonaAgent(monitorId: string, appId: string, personaId: string): PersonaAgent | undefined {
    return this.personaAgents.get(personaAgentKey(monitorId, appId, personaId));
  }

  /** Every persona one app owns on one monitor, oldest first. */
  listPersonaAgents(monitorId: string, appId: string): PersonaAgent[] {
    return [...this.personaAgents.values()]
      .filter((p) => p.monitorId === monitorId && p.appId === appId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** True while the persona's provider is streaming — one turn at a time per persona. */
  isPersonaBusy(record: PersonaAgent): boolean {
    return this.isBusy(record.agent);
  }

  /**
   * Run one persona turn, fire and forget.
   *
   * Deliberately not routed through `ContextPool`: a persona has no context tape,
   * no window, and no queue — the app's own scheduler decides who speaks and when,
   * and the pool's queues exist to serialize things a persona has no share in. What
   * it does share is the turn machinery, so the answer streams to
   * `yaar://agents/{instanceId}/stream` exactly like any other agent's, for free.
   *
   * The returned promise resolves when the turn ends; callers that want the verb to
   * return immediately (the app's `message` action does) simply don't await it. The
   * final text lands on `record.lastResponse` either way.
   */
  runPersonaTurn(record: PersonaAgent, content: string, messageId: string): Promise<void> {
    return record.agent.session.handleMessage(content, {
      role: personaRole(record.appId, record.personaId),
      source: monitorSource(record.monitorId),
      messageId,
      monitorId: record.monitorId,
      systemPromptOverride: record.systemPrompt,
      // The containment. See profiles/persona.ts — an empty allowlist is what stops
      // a runtime-supplied prompt from reaching a single tool or MCP server.
      allowedTools: [],
      ...(record.model ? { model: record.model } : {}),
      // Not a context tape write — nothing here reaches `ContextTape`. It is the one
      // callback that hands back the turn's final assistant text, which `read` serves
      // to an iframe that missed the `done` frame.
      onContextMessage: (role, text) => {
        if (role === 'assistant') record.lastResponse = text;
      },
    });
  }

  /** Dispose one persona. Returns false when the app never spawned it. */
  async disposePersonaAgent(monitorId: string, appId: string, personaId: string): Promise<boolean> {
    const key = personaAgentKey(monitorId, appId, personaId);
    const record = this.personaAgents.get(key);
    if (!record) return false;

    this.personaAgents.delete(key);
    await this.disposeAgent(
      record.agent,
      `Persona "${personaId}" disposed for ${appId} on monitor ${monitorId}`,
    );
    return true;
  }

  /** Dispose every persona one app owns on one monitor. Returns how many died. */
  async disposePersonasForApp(monitorId: string, appId: string): Promise<number> {
    const personas = this.listPersonaAgents(monitorId, appId);
    for (const p of personas) {
      await this.disposePersonaAgent(monitorId, appId, p.personaId);
    }
    return personas.length;
  }

  /** Dispose every persona on a monitor, whichever app owns it. */
  async disposePersonasForMonitor(monitorId: string): Promise<void> {
    const doomed = [...this.personaAgents.values()].filter((p) => p.monitorId === monitorId);
    for (const p of doomed) {
      await this.disposePersonaAgent(monitorId, p.appId, p.personaId);
    }
  }

  // ── Session agent ────────────────────────────────────────────────

  /**
   * Create the session agent (lazy singleton for cross-monitor oversight).
   */
  async createSessionAgent(): Promise<PooledAgent | null> {
    if (this.sessionAgent) return this.sessionAgent;

    const provider = await this.acquireProvider();
    const agent = await this.createAgentCore(provider ?? undefined);
    if (!agent) {
      if (provider) await provider.dispose();
      return null;
    }

    this.sessionAgent = agent;
    console.log(`[AgentPool] Session agent created: ${agent.instanceId}`);
    return agent;
  }

  /**
   * Get the session agent (null if not created).
   */
  getSessionAgent(): PooledAgent | null {
    return this.sessionAgent;
  }

  /**
   * Check if the session agent exists.
   */
  hasSessionAgent(): boolean {
    return this.sessionAgent !== null;
  }

  /**
   * Dispose the session agent.
   */
  async disposeSessionAgent(): Promise<void> {
    const agent = this.sessionAgent;
    if (!agent) return;

    this.sessionAgent = null;
    await this.disposeAgent(agent, 'Session agent disposed');
  }

  /**
   * Check if an agent with the given instanceId exists in this pool.
   */
  hasAgent(agentId: string): boolean {
    return this.agentIds.has(agentId);
  }

  /**
   * Find the monitorId for a given agent instanceId.
   *
   * App agents count: they are keyed by the monitor whose windows they drive, and
   * callers (notably the MCP request context, which scopes every window lookup by
   * `getMonitorId()`) must see that monitor. Omitting them here would silently
   * place every app agent on monitor 0 — an app agent on monitor 1 would then look
   * for its own window on monitor 0 and not find it.
   */
  findMonitorForAgent(agentId: string): string | undefined {
    for (const { agent, type, monitorId } of this.allAgents()) {
      if (agent.instanceId !== agentId) continue;
      // The session agent lives in no monitor collection; it borrows the monitor of
      // the turn it is running. Ephemerals have none, and answer undefined.
      return type === 'session' ? this.sessionAgentMonitorId : monitorId;
    }
    return undefined;
  }

  /**
   * Find the app and owning monitor for a given agent instanceId (app agents only).
   */
  findAppForAgent(agentId: string): { monitorId: string; appId: string } | undefined {
    for (const [key, agent] of this.appAgents) {
      if (agent.instanceId === agentId) return parseAppKey(key);
    }
    return undefined;
  }

  /**
   * Resolve the principal tier of an agent from which collection it lives in.
   * The session agent is the only privileged principal; monitor, ephemeral, and
   * app agents are sandboxed workers. Returns undefined for unknown agents
   * (treated as non-session by access control).
   */
  getRoleForAgent(agentId: string): AgentRole | undefined {
    for (const { agent, type } of this.allAgents()) {
      if (agent.instanceId !== agentId) continue;
      // Ephemerals are unprivileged workers spawned by a monitor turn — same tier.
      if (type === 'ephemeral') return 'monitor';
      // Personas are the app tier's own workers. Belt and braces: they run with an
      // empty tool allowlist, so no MCP request ever arrives carrying one's token,
      // and if one somehow did it would land in the least-privileged tier there is.
      if (type === 'persona') return 'app';
      return type;
    }
    return undefined;
  }

  // ── Steer ──────────────────────────────────────────────────────────

  /**
   * Try to steer the monitor agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steerMonitorAgent(monitorId = '0', content: string): Promise<boolean> {
    const agent = this.monitorAgents.get(monitorId);
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  /**
   * Try to steer an app agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steerAppAgent(monitorId: string, appId: string, content: string): Promise<boolean> {
    const agent = this.appAgents.get(appKey(monitorId, appId));
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  // ── Query / interrupt ───────────────────────────────────────────────

  /**
   * Interrupt all running agents (monitor, app, ephemeral).
   */
  async interruptAll(): Promise<void> {
    for (const { agent } of this.allAgents()) {
      await agent.session.interrupt();
    }
  }

  /**
   * Interrupt a specific agent, identified either by its current role
   * (`monitor-{messageId}`, `app-{id}`, …) or by its instanceId — the id
   * `listAgents()` reports, which is stable across turns.
   */
  async interruptByIdOrRole(idOrRole: string): Promise<boolean> {
    for (const { agent } of this.allAgents()) {
      if (agent.currentRole === idOrRole || agent.instanceId === idOrRole) {
        await agent.session.interrupt();
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any agent has a role starting with the given prefix.
   */
  hasRolePrefix(prefix: string): boolean {
    for (const { agent } of this.allAgents()) {
      if (agent.currentRole?.startsWith(prefix)) return true;
    }
    return false;
  }

  // ── Roster ─────────────────────────────────────────────────────────

  /**
   * List every live agent, one entry each. `getStats()` only counts them;
   * this names them, so a caller can show a roster and interrupt a specific
   * agent by `id` (see `interruptByIdOrRole`).
   */
  listAgents(): AgentEntry[] {
    const entries: AgentEntry[] = [];
    for (const { agent, type, monitorId, appId, personaId } of this.allAgents()) {
      const id = agent.instanceId;
      const busy = this.isBusy(agent);
      const usage = agent.session.getUsage();
      switch (type) {
        case 'session':
          entries.push({ id, type, label: 'session', busy, usage });
          break;
        case 'monitor':
          entries.push({ id, type, label: `monitor ${monitorId}`, busy, monitorId, usage });
          break;
        case 'app':
          entries.push({
            id,
            type,
            label: `${appId} (monitor ${monitorId})`,
            busy,
            monitorId,
            appId,
            usage,
          });
          break;
        case 'persona':
          entries.push({
            id,
            type,
            label: `${personaId} · ${appId} (monitor ${monitorId})`,
            busy,
            monitorId,
            appId,
            personaId,
            usage,
          });
          break;
        case 'ephemeral':
          entries.push({ id, type, label: agent.currentRole ?? 'ephemeral', busy, usage });
          break;
      }
    }
    return entries;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  /**
   * Get pool statistics.
   */
  getStats(): AgentPoolStats {
    let total = 0;
    let idle = 0;
    let busy = 0;
    let usage = this.retiredUsage;

    for (const { agent } of this.allAgents()) {
      total++;
      if (this.isBusy(agent)) busy++;
      else idle++;
      usage = addUsage(usage, agent.session.getUsage());
    }

    return {
      totalAgents: total,
      idleAgents: idle,
      busyAgents: busy,
      monitorAgents: this.monitorAgents.size,
      appAgents: this.appAgents.size,
      personaAgents: this.personaAgents.size,
      ephemeralAgents: this.ephemeralAgents.size,
      sessionAgent: this.sessionAgent !== null,
      usage,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Clean up all agents and release resources.
   */
  async cleanup(): Promise<void> {
    const limiter = getAgentLimiter();
    // Snapshot before the first await: the two phases must walk the same roster.
    const allAgents = [...this.allAgents()].map((e) => e.agent);

    // Phase 1: interrupt all running agents
    for (const agent of allAgents) {
      await agent.session.interrupt();
    }

    // Phase 2: dispose providers and release limiter slots
    for (const agent of allAgents) {
      await agent.session.cleanup();
      limiter.release();
    }

    this.sessionAgent = null;
    this.monitorAgents.clear();
    this.appAgents.clear();
    this.personaAgents.clear();
    this.ephemeralAgents.clear();
    for (const id of this.agentIds) {
      getSessionHub().unregisterAgent(id);
    }
    this.agentIds.clear();
    notifyAgentsChanged(this.sessionId);
  }
}
