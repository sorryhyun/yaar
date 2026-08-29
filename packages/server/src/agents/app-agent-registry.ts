/**
 * The app-agent tier: one persistent agent per (monitor, app), created on the first
 * interaction with the app's window and reused for every one after it. A second monitor
 * opening the same app gets its own agent — the key is `{monitorId}::{appId}`
 * (see `appAgentKey`).
 *
 * Lifted out of `agent-pool.ts` the way the sub-agent tier was (`SubAgentRegistry`):
 * it reaches back for exactly two things the pool owns — making an agent, disposing
 * one — and both arrive as constructor callbacks. What lives here is the tier's own
 * rules: the reuse-or-reserve spawn, the idle reaper, and the settle-before-sweep
 * teardown. The persona tier deliberately does NOT hang off this registry: a persona's
 * owner is the (monitor, app) pair, not the app agent — reclaiming both on a monitor's
 * death is the pool's cross-tier orchestration (`AgentPool.disposeAppAgentsForMonitor`).
 */

import { APP_AGENT_IDLE_MS, APP_AGENT_SWEEP_MS } from '../config.js';
import {
  appAgentKey,
  parseAppKey,
  isAgentBusy,
  type AgentHost,
  type PooledAgent,
  type RosterMember,
} from './agent-roster.js';
import { SpawnReservations } from './spawn-reservations.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('AppAgentRegistry');

/** How a spawn reservation is matched without parsing its key back out. */
interface SpawnTag {
  monitorId: string;
  appId: string;
}

export class AppAgentRegistry {
  /** Persistent per-app agents, keyed by `{monitorId}::{appId}` (see `appAgentKey`). */
  private records = new Map<string, PooledAgent>();

  /**
   * App-agent creations reserved but not yet landed, keyed like {@link records}.
   *
   * Two app tasks for one app already overlap whenever one of them carries an
   * `actionId`: parallel button actions skip the processing lock on purpose. A `fresh`
   * turn widens the window further, since it empties the map deliberately and then
   * asks for a replacement. See {@link SpawnReservations} for the leak class this
   * closes.
   */
  private spawns = new SpawnReservations<PooledAgent, SpawnTag>();

  /**
   * The idle reaper's interval — armed with the first app agent, disarmed with the
   * last. Null whenever this registry has none. See {@link reapIdle}.
   */
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: AgentHost) {}

  /**
   * Get or create the agent for one app on one monitor. First call for a
   * (monitorId, appId) pair creates a fresh agent; subsequent calls reuse it.
   */
  async getOrCreate(monitorId: string, appId: string): Promise<PooledAgent | null> {
    const key = appAgentKey(monitorId, appId);
    const existing = this.records.get(key);
    if (existing) {
      // Touched on the way out, not only when a turn starts: an agent handed to a
      // caller that has not begun its turn yet is neither busy nor idle, and the reaper
      // must not take it out from under them.
      existing.lastUsed = Date.now();
      log.info('reusing app agent', { appId, monitorId, instanceId: existing.instanceId });
      return existing;
    }

    // A creation already in flight for this key: join it rather than start a second
    // one. The joiner gets the same agent it would have found had it arrived one tick
    // later. Reserved before the first await — see `SpawnReservations`.
    const inFlight = this.spawns.get(key);
    if (inFlight) return inFlight;

    return this.spawns.reserve(key, { monitorId, appId }, () => this.create(monitorId, appId));
  }

  /**
   * The creation itself. Only ever called with a reservation held, which is what makes
   * the `records.set` below the only writer for that key.
   */
  private async create(monitorId: string, appId: string): Promise<PooledAgent | null> {
    const agent = await this.host.createAgent();
    if (!agent) return null;

    this.records.set(appAgentKey(monitorId, appId), agent);
    this.armIdleSweep();
    log.info('app agent created', { appId, monitorId, instanceId: agent.instanceId });
    return agent;
  }

  // ── Idle reaper ──────────────────────────────────────────────────────
  //
  // The last window of an app on a monitor takes its agent with it, which is what
  // reclaims the common case. This is the backstop for the rest: an app whose window
  // stays open all day, and whose agent sat busy-free behind it. Against a
  // *process-global* limit of ten, eight such apps permanently held eight slots — and
  // the ninth app, plus every other session on the machine, got "Agent limit reached"
  // with no way to get a slot back short of a restart.
  //
  // One registry-level interval rather than a timer per agent: `lastUsed` is already
  // written on every turn, so a sweep needs no new call sites, cannot leave a timer
  // behind on a disposed agent, and costs one unref'd handle per session that has any
  // app agents at all.

  private armIdleSweep(): void {
    if (this.idleSweepTimer || APP_AGENT_IDLE_MS <= 0) return;
    this.idleSweepTimer = setInterval(() => {
      void this.reapIdle();
    }, APP_AGENT_SWEEP_MS);
    // Never the reason the process stays up.
    this.idleSweepTimer.unref?.();
  }

  /**
   * Stop the sweep. Idempotent; `clear()` calls it too. `AgentPool.cleanup()` calls it
   * *first* — before the settle/snapshot/dispose sequence — so a sweep cannot fire
   * concurrently with the teardown walking the same agents.
   */
  stopSweep(): void {
    if (!this.idleSweepTimer) return;
    clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = null;
  }

  /**
   * Dispose app agents that have gone quiet, freeing their global slots.
   *
   * Reaping costs the agent's memory — it lives in the provider session `dispose` ends —
   * which is exactly what a `fresh:true` turn does on purpose. The app's *sub-agents*
   * survive, for the reason they survive a `fresh` turn: their owner is the
   * (monitor, app) pair, not the app agent.
   */
  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const expired: Array<{ monitorId: string; appId: string }> = [];

    for (const [key, agent] of this.records) {
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
      await this.dispose(monitorId, appId, 'idle');
    }

    if (this.records.size === 0) this.stopSweep();
  }

  // ── Lookup ───────────────────────────────────────────────────────────

  /** The agent for a given app on a given monitor (if it exists). */
  get(monitorId: string, appId: string): PooledAgent | undefined {
    return this.records.get(appAgentKey(monitorId, appId));
  }

  /** Whether an agent exists for the given app on the given monitor. */
  has(monitorId: string, appId: string): boolean {
    return this.records.has(appAgentKey(monitorId, appId));
  }

  /** How many app agents exist, across every app and monitor. */
  get size(): number {
    return this.records.size;
  }

  /** The app and owning monitor for a given agent instanceId. */
  findByAgentId(agentId: string): { monitorId: string; appId: string } | undefined {
    for (const [key, agent] of this.records) {
      if (agent.instanceId === agentId) return parseAppKey(key);
    }
    return undefined;
  }

  /** Every live app agent, for the pool's single roster traversal. */
  *members(): Iterable<RosterMember> {
    for (const [key, agent] of this.records) {
      yield { agent, type: 'app', ...parseAppKey(key) };
    }
  }

  // ── Steer ────────────────────────────────────────────────────────────

  /**
   * Try to steer an app agent's active turn with additional input.
   * Returns true if steering succeeded, false otherwise.
   */
  async steer(monitorId: string, appId: string, content: string): Promise<boolean> {
    const agent = this.records.get(appAgentKey(monitorId, appId));
    if (!agent || !agent.session.isRunning()) return false;
    return agent.session.steer(content);
  }

  // ── Disposal ─────────────────────────────────────────────────────────

  /**
   * Dispose the agent for a given app on a given monitor.
   *
   * Settles a creation still in flight first, for the reason {@link SpawnReservations}
   * rule 3 gives: one inside the provider acquire is in no collection yet, so the
   * delete below would walk past it and the agent would land moments later — alive,
   * unreferenced, and holding a slot until the session ends. A `fresh` turn disposes
   * and then immediately re-creates, so this is the ordinary case here, not the exotic
   * one.
   */
  async dispose(monitorId: string, appId: string, reason?: string): Promise<void> {
    const key = appAgentKey(monitorId, appId);
    await this.spawns.settle((tag) => tag.monitorId === monitorId && tag.appId === appId);

    const agent = this.records.get(key);
    if (!agent) return;

    this.records.delete(key);
    await this.host.disposeAgent(
      agent,
      `App agent disposed${reason ? ` (${reason})` : ''} for ${appId} on monitor ${monitorId}`,
    );
  }

  /**
   * Dispose every app agent owned by a monitor. App agents belong to the monitor
   * whose windows they drive, so tearing the monitor down reclaims them — nothing
   * else would, and leaking them would hold limiter slots for a monitor that's gone.
   */
  async disposeForMonitor(monitorId: string): Promise<void> {
    // Same reason as in `dispose`, one tier up: enumerate only after the monitor's
    // in-flight creations have landed, or the sweep misses them.
    await this.spawns.settle((tag) => tag.monitorId === monitorId);

    const appIds = [...this.records.keys()]
      .map(parseAppKey)
      .filter((k) => k.monitorId === monitorId)
      .map((k) => k.appId);

    for (const appId of appIds) {
      await this.dispose(monitorId, appId);
    }
  }

  /** Wait out in-flight creations a teardown is about to sweep past (rule 3). */
  settleSpawns(match: (tag: { monitorId: string; appId: string }) => boolean): Promise<void> {
    return this.spawns.settle(match);
  }

  /**
   * Forget every record without disposing anyone — for `AgentPool.cleanup()`, whose
   * roster snapshot already holds the agents and disposes them itself.
   */
  clear(): void {
    this.stopSweep();
    this.records.clear();
  }
}
