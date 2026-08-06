/**
 * AgentPool - manages agents with role-based lifecycle.
 *
 * The collections below are a **tree**, not four independent registries — see
 * `docs/architecture/agent_tree.md`:
 *
 *   session agent                       (1 per session)   cross-monitor oversight
 *   └─ monitor agent                    `monitorId`       the desktop's hands
 *      └─ app agent                     `monitorId::appId`   the process's main thread
 *         └─ sub-agent                  `monitorId::appId::subId`   worker threads
 *
 * Each tier's key extends its owner's, each is addressed through its owner, and
 * disposal cascades downward.
 *
 * **What reclaims what is not symmetric, and readers assume it is.** Disposing a
 * monitor takes its app agents and their sub-agents with it. Closing a *window*
 * reclaims only sub-agents — an app agent survives every one of its windows closing,
 * because it is keyed by (monitor, app) and the next window of that app is meant to
 * find it still holding the conversation. What eventually reclaims it is idleness
 * (`reapIdleAppAgents`), `fresh:true`, monitor removal, explicit delete, or session
 * teardown.
 *
 * Agent types:
 * - Monitor agents: persistent per-monitor, handle USER_MESSAGE, provider session continuity
 * - Ephemeral agents: fresh provider, no context, disposed after one task
 * - App agents: persistent per (monitor, app), handle app protocol communication
 * - Sub-agents: N per (monitor, app), prompt supplied by the app at runtime — the whole
 *   tier lives in {@link SubAgentRegistry}, reached through the {@link subAgents} door
 *
 * What is left in this file is lifecycle: making an agent, tearing one down, and the
 * global slot each holds. The record itself, the roster projections and the composite
 * keys are `agent-roster.ts`; the reserve-before-first-await rule every tier shares is
 * `spawn-reservations.ts`.
 *
 * Used by ContextPool to decouple agent lifecycle from task orchestration.
 */

import { AgentSession } from './agent-session.js';
import { getAgentLimiter } from './limiter.js';
import { acquireWarmProvider } from '../providers/factory.js';
import { getSessionHub } from '../session/session-hub.js';
import { notifyAgentsChanged } from '../http/subscriptions.js';
import { genId } from '../lib/ids.js';
import { revokeAgentToken } from '../mcp/agent-tokens.js';
import { APP_AGENT_IDLE_MS, APP_AGENT_SWEEP_MS } from '../config.js';
import {
  appAgentKey,
  buildAgentTree,
  isAgentBusy,
  listAgents as buildRoster,
  parseAppKey,
  type AgentEntry,
  type AgentTreeNode,
  type PooledAgent,
  type RosterMember,
} from './agent-roster.js';
import { SpawnReservations } from './spawn-reservations.js';
import { SubAgentRegistry } from './sub-agent-registry.js';
import type { ServerEvent } from '@yaar/shared';
import type { SessionId } from '../session/types.js';
import type { SessionLogger } from '../logging/index.js';
import type { AITransport, TokenUsage } from '../providers/types.js';
import type { AgentRole } from './agent-context.js';
import type { AgentPoolStats } from './pool-types.js';

const appKey = appAgentKey;

/** How a spawn reservation is matched without parsing its key back out. */
interface SpawnTag {
  monitorId: string;
  appId: string;
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
   * The app-agent idle reaper's interval — armed with the first app agent, disarmed
   * with the last. Null whenever this pool has none. See {@link reapIdleAppAgents}.
   */
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * App-agent creations reserved but not yet landed, keyed like {@link appAgents}.
   *
   * Two app tasks for one app already overlap whenever one of them carries an
   * `actionId`: parallel button actions skip the processing lock on purpose. A `fresh`
   * turn widens the window further, since it empties the map deliberately and then
   * asks for a replacement. See {@link SpawnReservations} for the leak class this
   * closes.
   */
  private appAgentSpawns = new SpawnReservations<PooledAgent, SpawnTag>();

  /**
   * The sub-agent tier — the app tier's children, one key-extension down.
   *
   * Public because it is the door, not a pass-through: everything about that tier (its
   * cap, its turn, who reclaims it) is the registry's, and the pool supplies it only
   * the two services below. `ContextPool.agentPool` is the same shape one level up.
   */
  readonly subAgents = new SubAgentRegistry({
    createAgent: () => this.createWithFreshProvider(),
    disposeAgent: (agent, label) => this.disposeAgent(agent, label),
  });

  /** Session agent — lazy singleton for cross-monitor oversight. */
  private sessionAgent: PooledAgent | null = null;

  /**
   * The monitor the session agent is running its current turn on.
   *
   * The session agent lives in no monitor collection, so `findMonitorForAgent` cannot
   * answer for it the way it can for a monitor agent. It runs on a monitor like every
   * other agent — the one the user spoke from — so it says which, for the length of
   * the turn.
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

  /**
   * Returns false if this id was already untracked — which is also the answer to
   * "has someone else already disposed this agent?", and the whole of
   * {@link disposeAgent}'s idempotence. The `delete` is synchronous, so two
   * concurrent disposers cannot both win it.
   */
  private untrackAgent(instanceId: string): boolean {
    if (!this.agentIds.delete(instanceId)) return false;
    getSessionHub().unregisterAgent(instanceId);
    notifyAgentsChanged(this.sessionId);
    return true;
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
  private *allAgents(): Iterable<RosterMember> {
    if (this.sessionAgent) yield { agent: this.sessionAgent, type: 'session' };
    for (const [monitorId, agent] of this.monitorAgents) {
      yield { agent, type: 'monitor', monitorId };
    }
    for (const [key, agent] of this.appAgents) {
      yield { agent, type: 'app', ...parseAppKey(key) };
    }
    yield* this.subAgents.members();
    for (const agent of this.ephemeralAgents) yield { agent, type: 'ephemeral' };
  }

  // ── Agent disposal ───────────────────────────────────────────────────

  /**
   * Tear one agent down, after its owner has already removed it from whichever
   * collection held it. `label` is the log line's subject ("Session agent disposed").
   *
   * `interruptIfRunning` is false for exactly one caller — `disposeEphemeral`, which
   * runs after its one task has finished and never interrupted. Cleanup is allowed to
   * throw through to the caller; the limiter slot is released either way.
   *
   * **Idempotent per agent, and that is load-bearing.** Two dispose paths reach the
   * same agent whenever a fire-and-forget disposer races `cleanup()`'s roster
   * snapshot — `MonitorRegistry.remove` never awaits `removeMonitorAgent`, and
   * `WindowEventCoordinator` only `.catch()`es `subAgents.disposeForApp`. A second
   * `release()` would take the process-global count *below* the number of live
   * agents, permanently, and the process then admits past `MAX_AGENTS`. The
   * `agentIds` delete decides the race before the first await; the loser returns
   * having touched nothing.
   */
  private async disposeAgent(
    agent: PooledAgent,
    label: string,
    { interruptIfRunning = true }: { interruptIfRunning?: boolean } = {},
  ): Promise<void> {
    if (!this.untrackAgent(agent.instanceId)) return;
    // The credential dies with the agent it names. Without this the two token maps
    // grew for the process's life and a disposed agent's `X-Agent-Token` stayed
    // resolvable — it failed closed only downstream, where `findRoleForAgent` has no
    // agent to answer for, which is a coincidence rather than a design.
    revokeAgentToken(agent.instanceId);
    // The layout deltas are keyed by agent id and were never dropped, so the map only
    // ever grew. Through the hub because the session owns the LayoutContext and a pool
    // that outlives its session has nothing to clear.
    getSessionHub().get(this.sessionId)?.layoutContext.removeAgent(agent.instanceId);
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
   *
   * The slot is acquired before the first await and handed to the agent only on the
   * success path. Every other exit — a refused initialize, or a *throw* out of it
   * (`acquireWarmProvider` raises `CodexVersionError`, and nothing in the pool's call
   * chain catches it) — gives the slot back here. Held on the throwing path, it was
   * held for the life of the process, invisibly: no agent exists to show in
   * `/api/agents/stats`, and no dispose path will ever reach one.
   */
  private async createAgentCore(preWarmedProvider?: AITransport): Promise<PooledAgent | null> {
    const limiter = getAgentLimiter();
    if (!limiter.tryAcquire()) {
      console.log('[AgentPool] Global agent limit reached');
      return null;
    }
    let slotHandedOver = false;

    try {
      const id = this.nextAgentId++;
      // `agent-${id}-${Date.now()}` was not unique across pools: the counter restarts
      // at 0 in every pool, so two sessions creating their first agent in the same
      // millisecond minted the same id — and the three registries keyed by it are all
      // process-global. `SessionHub.registerAgent` silently overwrites (so
      // `findSessionByAgent` routes one session's agent to the other), the
      // `InterruptGate` gates both from either one's stop, and `getAgentToken` hands
      // both the same MCP credential. The counter stays for readable logs; `genId` is
      // what makes the string an identity.
      const instanceId = genId(`agent-${id}`);

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
      if (!initialized) return null;

      const agent: PooledAgent = {
        session,
        id,
        instanceId,
        lastUsed: Date.now(),
        currentRole: null,
      };

      // Past this line the agent owns the slot and `disposeAgent` releases it.
      this.trackAgent(instanceId);
      slotHandedOver = true;

      console.log(`[AgentPool] Created agent ${id} (${instanceId})`);
      return agent;
    } finally {
      if (!slotHandedOver) limiter.release();
    }
  }

  /**
   * Acquire a provider, build an agent on it, and hand the provider back if the
   * build fails. Every tier that supplies its own provider goes through here.
   *
   * The compensation is the whole point: `createAgentCore` returns `null` for a
   * refused limiter slot, and a provider acquired a line earlier is a live child
   * process (or a warm-pool slot) that nothing else holds a reference to. Written
   * out at four call sites before this existed, which is four chances to forget it.
   *
   * `createMonitorAgent` is deliberately not a caller — `ContextPool` supplies that
   * tier's provider from the warm pool and owns its disposal.
   *
   * A *throw* out of `createAgentCore` gets the same compensation as a `null`: the
   * `if (!agent)` shape it replaced was skipped entirely on that path, so the child
   * process outlived every reference to it.
   */
  private async createWithFreshProvider(): Promise<PooledAgent | null> {
    const provider = await this.acquireProvider();
    let agent: PooledAgent | null = null;
    try {
      agent = await this.createAgentCore(provider ?? undefined);
      return agent;
    } finally {
      if (!agent && provider) await provider.dispose();
    }
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
    const agent = await this.createWithFreshProvider();
    if (!agent) return null;
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
    return isAgentBusy(agent);
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
      // Touched on the way out, not only when a turn starts: an agent handed to a
      // caller that has not begun its turn yet is neither busy nor idle, and the reaper
      // must not take it out from under them.
      existing.lastUsed = Date.now();
      console.log(
        `[AgentPool] Reusing app agent for ${appId} on monitor ${monitorId}: ${existing.instanceId}`,
      );
      return existing;
    }

    // A creation already in flight for this key: join it rather than start a second
    // one. The joiner gets the same agent it would have found had it arrived one tick
    // later. Reserved before the first await — see `SpawnReservations`.
    const inFlight = this.appAgentSpawns.get(key);
    if (inFlight) return inFlight;

    return this.appAgentSpawns.reserve(key, { monitorId, appId }, () =>
      this.createAppAgent(monitorId, appId),
    );
  }

  /**
   * The creation itself. Only ever called with a reservation held, which is what makes
   * the `appAgents.set` below the only writer for that key.
   */
  private async createAppAgent(monitorId: string, appId: string): Promise<PooledAgent | null> {
    const agent = await this.createWithFreshProvider();
    if (!agent) return null;

    this.appAgents.set(appKey(monitorId, appId), agent);
    this.armIdleSweep();
    console.log(
      `[AgentPool] App agent created for ${appId} on monitor ${monitorId}: ${agent.instanceId}`,
    );
    return agent;
  }

  // ── App-agent idle reaper ────────────────────────────────────────────
  //
  // App agents are the one tier nothing else reclaims: not window close, not idleness,
  // only `fresh:true`, monitor removal, explicit delete, or session teardown. Against a
  // *process-global* limit of ten, eight apps opened once and left alone permanently
  // held eight slots — and the ninth app, plus every other session on the machine, got
  // "Agent limit reached" with no way to get a slot back short of a restart.
  //
  // One pool-level interval rather than a timer per agent: `lastUsed` is already
  // written on every turn, so a sweep needs no new call sites, cannot leave a timer
  // behind on a disposed agent, and costs one unref'd handle per session that has any
  // app agents at all.

  private armIdleSweep(): void {
    if (this.idleSweepTimer || APP_AGENT_IDLE_MS <= 0) return;
    this.idleSweepTimer = setInterval(() => {
      void this.reapIdleAppAgents();
    }, APP_AGENT_SWEEP_MS);
    // Never the reason the process stays up.
    this.idleSweepTimer.unref?.();
  }

  private disarmIdleSweep(): void {
    if (!this.idleSweepTimer) return;
    clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = null;
  }

  /**
   * Dispose app agents that have gone quiet, freeing their global slots.
   *
   * Reaping costs the agent's memory — it lives in the provider session
   * `disposeAppAgent` ends — which is exactly what a `fresh:true` turn does on purpose.
   * The app's *sub-agents* survive, for the reason they survive a `fresh` turn: their
   * owner is the (monitor, app) pair, not the app agent.
   */
  private async reapIdleAppAgents(): Promise<void> {
    const now = Date.now();
    const expired: Array<{ monitorId: string; appId: string }> = [];

    for (const [key, agent] of this.appAgents) {
      if (isAgentBusy(agent)) {
        // A busy agent's idle clock starts when it goes quiet, not when its turn
        // began: `lastUsed` is stamped at turn *start*, so a turn longer than the TTL
        // would otherwise be reapable the instant it finished.
        agent.lastUsed = now;
        continue;
      }
      if (now - agent.lastUsed >= APP_AGENT_IDLE_MS) expired.push(parseAppKey(key));
    }

    for (const { monitorId, appId } of expired) {
      await this.disposeAppAgent(monitorId, appId, 'idle');
    }

    if (this.appAgents.size === 0) this.disarmIdleSweep();
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
   *
   * Settles a creation still in flight first, for the reason {@link SpawnReservations}
   * rule 3 gives: one inside `acquireProvider` is in no collection yet, so the delete
   * below would walk past it and the agent would land moments later — alive,
   * unreferenced, and holding a slot until the session ends. A `fresh` turn disposes
   * and then immediately re-creates, so this is the ordinary case here, not the exotic
   * one.
   */
  async disposeAppAgent(monitorId: string, appId: string, reason?: string): Promise<void> {
    const key = appKey(monitorId, appId);
    await this.appAgentSpawns.settle((tag) => tag.monitorId === monitorId && tag.appId === appId);

    const agent = this.appAgents.get(key);
    if (!agent) return;

    this.appAgents.delete(key);
    await this.disposeAgent(
      agent,
      `App agent disposed${reason ? ` (${reason})` : ''} for ${appId} on monitor ${monitorId}`,
    );
  }

  /**
   * Dispose every app agent owned by a monitor. App agents belong to the monitor
   * whose windows they drive, so tearing the monitor down reclaims them — nothing
   * else would, and leaking them would hold limiter slots for a monitor that's gone.
   */
  async disposeAppAgentsForMonitor(monitorId: string): Promise<void> {
    // Same reason as in `disposeAppAgent`, one tier up: enumerate only after the
    // monitor's in-flight creations have landed, or the sweep misses them.
    await this.appAgentSpawns.settle((tag) => tag.monitorId === monitorId);

    const appIds = [...this.appAgents.keys()]
      .map(parseAppKey)
      .filter((k) => k.monitorId === monitorId)
      .map((k) => k.appId);

    for (const appId of appIds) {
      await this.disposeAppAgent(monitorId, appId);
    }

    // Not folded into the loop above: a persona is spawned by an app's *iframe*,
    // which needs no app agent to exist. An app that only ever talks to its personas
    // has entries there and none in `appAgents`, so walking app agents would reclaim
    // nothing and leak every slot the monitor's personas hold.
    await this.subAgents.disposeForMonitor(monitorId);
  }

  // ── Session agent ────────────────────────────────────────────────

  /**
   * Create the session agent (lazy singleton for cross-monitor oversight).
   */
  async createSessionAgent(): Promise<PooledAgent | null> {
    if (this.sessionAgent) return this.sessionAgent;

    const agent = await this.createWithFreshProvider();
    if (!agent) return null;

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
      // Sub-agents are the app tier's own workers, and the tier they land in is the
      // least-privileged one there is. It is load-bearing for a tool-bearing one,
      // whose tool calls *do* arrive over MCP carrying its token: the role is what
      // the `session-principal` gate reads, so a sub-agent asking for
      // `yaar://session/*` is refused by the same check that refuses its app.
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
   * Interrupt every *running* agent (monitor, app, ephemeral).
   *
   * Idle agents are skipped, and the skip is load-bearing rather than an
   * optimization: interrupting an idle agent is not free. A prewarmed Claude
   * agent holds an open stream, and stopping it costs the warm process — the
   * first message after any "stop all" would then pay a cold start. Worse
   * before this skip existed, the idle path aborted that stream's controller
   * while leaving the session record pointing at the dead process, so the next
   * turn reused it and answered nothing at all.
   */
  async interruptAll(): Promise<void> {
    // Concurrently, because each interrupt now waits for its provider to
    // acknowledge: serially, the user's stop would take as long as the sum of
    // every agent's acknowledgement, and the last agent stopped would keep
    // working through the wait for all the ones before it.
    await Promise.all(
      [...this.allAgents()]
        .filter(({ agent }) => agent.session.isRunning())
        .map(({ agent }) => agent.session.interrupt()),
    );
  }

  /**
   * Interrupt a specific agent, identified either by its current role
   * (`monitor-{messageId}`, `app-{id}`, …) or by its instanceId — the id
   * `listAgents()` reports, which is stable across turns.
   *
   * Returns true when the named agent exists, whether or not it had a turn to
   * stop: "already idle" is the outcome the caller asked for, and reporting it
   * as "no such agent" would send a caller looking for a bug that isn't there.
   */
  async interruptByIdOrRole(idOrRole: string): Promise<boolean> {
    for (const { agent } of this.allAgents()) {
      if (agent.currentRole === idOrRole || agent.instanceId === idOrRole) {
        if (agent.session.isRunning()) await agent.session.interrupt();
        return true;
      }
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
    return buildRoster(this.allAgents());
  }

  /**
   * The same roster, nested by ownership — see `buildAgentTree`.
   *
   * `listAgents()` stays flat because that is what every existing consumer indexes,
   * interrupts, and filters over. This is the other view of the identical data, for
   * the reader who needs to see whose child is whose.
   */
  agentTree(): AgentTreeNode[] {
    return buildAgentTree(this.listAgents());
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
      if (isAgentBusy(agent)) busy++;
      else idle++;
      usage = addUsage(usage, agent.session.getUsage());
    }

    return {
      totalAgents: total,
      idleAgents: idle,
      busyAgents: busy,
      monitorAgents: this.monitorAgents.size,
      appAgents: this.appAgents.size,
      personaAgents: this.subAgents.size,
      ephemeralAgents: this.ephemeralAgents.size,
      sessionAgent: this.sessionAgent !== null,
      usage,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Clean up all agents and release resources.
   *
   * Every teardown goes through {@link disposeAgent}, one agent at a time, and no
   * agent's failure ends the sweep. This used to be a hand-rolled
   * `await cleanup(); limiter.release()` loop with no `try/finally`: the first
   * throwing agent leaked its own slot *and* every slot after it, the collections
   * below never cleared, and the throw propagated into `ContextPool.teardown`, which
   * swallows it — so a single provider that failed to die took a permanent bite out
   * of the process-global `MAX_AGENTS` with nothing anywhere saying so.
   *
   * Never throws, for the same reason: the caller has no recovery to offer, and a
   * teardown that stops early is the failure mode being fixed.
   */
  async cleanup(): Promise<void> {
    this.disarmIdleSweep();
    // Before the snapshot: a persona still mid-spawn is in no collection, so it would
    // land in the registry after the clear below and outlive the pool that owns it.
    await this.subAgents.settleSpawns(() => true);
    await this.appAgentSpawns.settle(() => true);
    // Snapshot before the first await: the two phases must walk the same roster.
    const allAgents = [...this.allAgents()].map((e) => e.agent);

    // Emptied before the first dispose await, not after: `disposeAgent`'s contract is
    // that its caller has already removed the agent from whichever collection held it,
    // and a dispose that throws must not leave the pool advertising an agent it has
    // torn down. Double-release is impossible regardless — `disposeAgent` is
    // idempotent per agent id.
    this.sessionAgent = null;
    this.monitorAgents.clear();
    this.appAgents.clear();
    this.subAgents.clear();
    this.ephemeralAgents.clear();

    // Phase 1: stop everything before tearing anything down, so no agent is still
    // streaming while a sibling's provider goes away.
    for (const agent of allAgents) {
      try {
        await agent.session.interrupt();
      } catch (err) {
        console.error(`[AgentPool] Interrupt failed for ${agent.instanceId}:`, err);
      }
    }

    // Phase 2: dispose providers and release limiter slots.
    for (const agent of allAgents) {
      try {
        await this.disposeAgent(agent, 'Agent disposed (pool cleanup)', {
          interruptIfRunning: false,
        });
      } catch (err) {
        console.error(`[AgentPool] Cleanup failed for ${agent.instanceId}:`, err);
      }
    }

    // Backstop for an id tracked but held by no collection — the leak class the spawn
    // reservations exist to prevent. `disposeAgent` has already untracked the rest.
    for (const id of this.agentIds) {
      getSessionHub().unregisterAgent(id);
    }
    this.agentIds.clear();
    notifyAgentsChanged(this.sessionId);
  }
}
