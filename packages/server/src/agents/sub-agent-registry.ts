/**
 * The sub-agent tier: N AI instances per (monitor, app), spawned by an app's own iframe.
 *
 * The app tier's children, one key-extension down —
 * `{monitorId}::{appId}::{subId}` (see `subAgentKey`). Monitor-scoped for the same
 * reason app agents are: the app that spawned them is itself scoped to the monitor whose
 * window it runs in, so two monitors running the same app get two independent casts and
 * neither can name the other's.
 *
 * Lifted out of `agent-pool.ts` because it touches exactly three things the pool owns —
 * making an agent, disposing one, and the global limiter's answer — and all three arrive
 * as constructor callbacks. What is left here is the tier's own rules: the cap, the
 * reservation, the turn, and who reclaims whom. See
 * [`docs/architecture/agent_tree.md`](../../../../docs/architecture/agent_tree.md) for
 * the four laws every node must satisfy.
 *
 * Containment is written once in `profiles/sub-agent.ts` and never composed at a call
 * site: a sub-agent holds one channel to its own app's iframe, wearing whatever tool
 * names the app declared at spawn, or no tools at all.
 */

import { buildSubAgentProfile, subAgentRole } from './profiles/sub-agent.js';
import type { SubAgentToolSpec } from './profiles/sub-agent.js';
import { monitorSource } from './context.js';
import {
  isAgentBusy,
  subAgentKey,
  type AgentHost,
  type PooledAgent,
  type RosterMember,
} from './agent-roster.js';
import { SpawnReservations } from './spawn-reservations.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('SubAgentRegistry');

/**
 * A sub-agent and the metadata its owning app spawned it with.
 *
 * The prompt lives here rather than on the provider because a persona's prompt is
 * *the persona*: it is replayed as `systemPromptOverride` on every turn, and the
 * provider's own `systemPrompt` (the generic YAAR one it was warmed with) is never
 * used. Keeping it on the record also means a busy check, a roster row, and a
 * respawn all read the same object.
 */
export interface SubAgent {
  agent: PooledAgent;
  monitorId: string;
  appId: string;
  /**
   * The sub-id its owning app spawned it under — the last component of
   * {@link subAgentKey}.
   *
   * The *wire* keeps `personaId` (`yaar://apps/self/agents/{personaId}`, the spawn
   * param, every response body) — that is shipped format, and
   * `handlers/apps/agents-resource.ts` is the one place the two spellings meet.
   */
  subId: string;
  /** Verbatim, caller-supplied. Replayed on every turn — see {@link buildSubAgentProfile}. */
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
  /**
   * The app-defined tools this sub-agent was spawned with; empty for a tool-less one.
   *
   * Prompt material plus a dispatch table, not a capability list — see
   * `profiles/sub-agent.ts`. The reach is fixed by the profile (one channel to the
   * owning app's own iframe); this only decides how many names it answers to and what
   * each one is *called* when it lands there (`persona:{name}`).
   */
  tools: SubAgentToolSpec[];
}

/**
 * What {@link SubAgentRegistry.spawn} did.
 *
 * Four outcomes rather than a nullable record because the verb handler owes the app
 * four different sentences: `reused` is a success the app should not treat as a new
 * character, `at-capacity` names its own `personas.max`, and `no-slot` names the
 * machine's `MAX_AGENTS`. Collapsing the last two into `null` made "close a window"
 * the advice for a limit only "delete a persona" could clear.
 */
export type SubAgentSpawnResult =
  | { status: 'created'; record: SubAgent }
  | { status: 'reused'; record: SubAgent }
  | { status: 'at-capacity' }
  | { status: 'no-slot' };

/**
 * What one spawn asks for: the prompt that makes the node, the tools it may dispatch
 * to its own app, and the app's own ceiling.
 *
 * Omitting `tools` is the plain case — a sub-agent that receives text and returns text.
 */
export interface SpawnSubAgentOptions {
  systemPrompt: string;
  model?: string;
  max: number;
  tools?: SubAgentToolSpec[];
}

export class SubAgentRegistry {
  private records = new Map<string, SubAgent>();
  private spawns = new SpawnReservations<SubAgent, { monitorId: string; appId: string }>();

  constructor(private readonly host: AgentHost) {}

  /**
   * Spawn a sub-agent for one app on one monitor, or hand back the one that already
   * answers to that id.
   *
   * Every decision here — does the persona exist, is one already on its way, is the
   * app at its ceiling — is taken **synchronously, before the first await**. That is
   * the whole point of the method. The shape it replaces checked existence and the
   * cap in the verb handler and *then* awaited a provider, so two spawns arriving in
   * one tick both passed both checks: the second overwrote the first in
   * `records`, and the first became an agent in no collection at all —
   * unreachable by every dispose path and by `AgentPool.cleanup()`, which walks its
   * single traversal. It held a provider process and a `MAX_AGENTS` slot until the
   * process died. An app spawning its cast with `Promise.all` is the ordinary way to
   * land there, and `spawn` is documented as safe to re-run on every mount.
   *
   * `max` is the app's `subagents.max`: the caller reads the manifest, this enforces
   * it, and reservations count toward it so the cap holds under concurrency too. The
   * cap is per (monitor, app) and counts every sub-agent, tool-bearing or not — a slot
   * is a provider process either way.
   */
  async spawn(
    monitorId: string,
    appId: string,
    subId: string,
    options: SpawnSubAgentOptions,
  ): Promise<SubAgentSpawnResult> {
    const key = subAgentKey(monitorId, appId, subId);

    const existing = this.records.get(key);
    if (existing) return { status: 'reused', record: existing };

    // A spawn already in flight for this id: join it rather than start a second one.
    // The joiner gets `reused`, which is the same answer it would have got had it
    // arrived one tick later and found the record in place.
    const inFlight = this.spawns.get(key);
    if (inFlight) {
      const record = await inFlight;
      return record ? { status: 'reused', record } : { status: 'no-slot' };
    }

    if (this.count(monitorId, appId) >= options.max) return { status: 'at-capacity' };

    const record = await this.spawns.reserve(key, { monitorId, appId }, () =>
      this.create(monitorId, appId, subId, options),
    );
    return record ? { status: 'created', record } : { status: 'no-slot' };
  }

  /**
   * The spawn itself. Only ever called with a reservation held, which is what makes
   * the `records.set` below the only writer for that key.
   *
   * Returns null when the global limiter has no slot — the caller surfaces that to
   * the app as a clean "agent limit reached" rather than a crash, since a room of
   * four characters plus the standing session/monitor/app trio sits close to the
   * `MAX_AGENTS` default.
   */
  private async create(
    monitorId: string,
    appId: string,
    subId: string,
    options: SpawnSubAgentOptions,
  ): Promise<SubAgent | null> {
    const agent = await this.host.createAgent();
    if (!agent) return null;

    const tools = options.tools ?? [];
    const record: SubAgent = {
      agent,
      monitorId,
      appId,
      subId,
      systemPrompt: options.systemPrompt,
      tools,
      ...(options.model ? { model: options.model } : {}),
      createdAt: Date.now(),
    };
    this.records.set(subAgentKey(monitorId, appId, subId), record);
    log.info('sub-agent spawned', {
      subId,
      tools: tools.length,
      appId,
      monitorId,
      instanceId: agent.instanceId,
    });
    return record;
  }

  /** Live sub-agents plus reservations — the number `subagents.max` is measured against. */
  private count(monitorId: string, appId: string): number {
    return (
      this.list(monitorId, appId).length +
      this.spawns.count((tag) => tag.monitorId === monitorId && tag.appId === appId)
    );
  }

  get(monitorId: string, appId: string, subId: string): SubAgent | undefined {
    return this.records.get(subAgentKey(monitorId, appId, subId));
  }

  /**
   * The sub-agent one MCP request is coming from, or undefined for every other
   * caller.
   *
   * The `subagent` MCP namespace is the one door whose *tool list* depends on who is
   * knocking (an app-defined set, fixed at spawn), so it needs the record behind the
   * agent token rather than just its id. Every other namespace registers the same
   * tools for everyone and never asks.
   */
  findByAgentId(agentId: string): SubAgent | undefined {
    for (const record of this.records.values()) {
      if (record.agent.instanceId === agentId) return record;
    }
    return undefined;
  }

  /** Every sub-agent one app owns on one monitor, oldest first, whatever the grade. */
  list(monitorId: string, appId: string): SubAgent[] {
    return [...this.records.values()]
      .filter((p) => p.monitorId === monitorId && p.appId === appId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** True while the sub-agent's provider is streaming — one turn at a time, each. */
  isBusy(record: SubAgent): boolean {
    return isAgentBusy(record.agent);
  }

  /** This tier's rows for the pool's single traversal. */
  *members(): Iterable<RosterMember> {
    for (const p of this.records.values()) {
      yield {
        agent: p.agent,
        type: 'persona',
        monitorId: p.monitorId,
        appId: p.appId,
        subId: p.subId,
      };
    }
  }

  /** How many sub-agents exist, across every app and monitor. */
  get size(): number {
    return this.records.size;
  }

  /**
   * Run one sub-agent turn, fire and forget.
   *
   * Deliberately not routed through `ContextPool`: a sub-agent has no context tape,
   * no window, and no queue — the app's own scheduler decides who speaks and when,
   * and the pool's queues exist to serialize things a sub-agent has no share in. What
   * it does share is the turn machinery, so the answer streams to
   * `yaar://agents/{instanceId}/stream` exactly like any other agent's, for free.
   *
   * The returned promise resolves when the turn ends; callers that want the verb to
   * return immediately (the app's `message` action does) simply don't await it. The
   * final text lands on `record.lastResponse` either way.
   *
   * The turn's hands come from {@link buildSubAgentProfile} and never from this
   * method. That is the shape law 3 asks for: this registry knows a record's declared
   * tool *names* and nothing about what a sub-agent may touch, so there is no branch
   * here that could be widened into "…and also these tools".
   */
  runTurn(record: SubAgent, content: string, messageId: string): Promise<void> {
    const profile = buildSubAgentProfile(record);
    return record.agent.session.handleMessage(content, {
      role: subAgentRole(record.appId, record.subId),
      source: monitorSource(record.monitorId),
      messageId,
      monitorId: record.monitorId,
      systemPromptOverride: profile.systemPrompt,
      // The containment. See profiles/sub-agent.ts — this allowlist is what decides
      // which MCP servers the turn even connects to (none when the sub-agent has
      // no tools, the `subagent` namespace alone when it has some), on both providers:
      // Claude derives them in `claude/sdk-options.ts`, Codex in `codexServerFilter`.
      allowedTools: profile.allowedTools,
      ...(record.model ? { model: record.model } : {}),
      // Not a context tape write — nothing here reaches `ContextTape`. It is the one
      // callback that hands back the turn's final assistant text, which `read` serves
      // to an iframe that missed the `done` frame.
      onContextMessage: (role, text) => {
        if (role === 'assistant') record.lastResponse = text;
      },
    });
  }

  /** Dispose one sub-agent. Returns false when the app never spawned it. */
  async dispose(monitorId: string, appId: string, subId: string): Promise<boolean> {
    const key = subAgentKey(monitorId, appId, subId);
    const record = this.records.get(key);
    if (!record) return false;

    this.records.delete(key);
    await this.host.disposeAgent(
      record.agent,
      `Sub-agent "${subId}" disposed for ${appId} on monitor ${monitorId}`,
    );
    return true;
  }

  /** Dispose every sub-agent one app owns on one monitor. Returns how many died. */
  async disposeForApp(monitorId: string, appId: string): Promise<number> {
    await this.settleSpawns((tag) => tag.monitorId === monitorId && tag.appId === appId);
    const doomed = this.list(monitorId, appId);
    for (const p of doomed) {
      await this.dispose(monitorId, appId, p.subId);
    }
    return doomed.length;
  }

  /** Dispose every sub-agent on a monitor, whichever app owns it. */
  async disposeForMonitor(monitorId: string): Promise<void> {
    await this.settleSpawns((tag) => tag.monitorId === monitorId);
    const doomed = [...this.records.values()].filter((p) => p.monitorId === monitorId);
    for (const p of doomed) {
      await this.dispose(monitorId, p.appId, p.subId);
    }
  }

  /**
   * Wait out the reservations a teardown is about to sweep past. See rule 3 on
   * {@link SpawnReservations}.
   */
  settleSpawns(match: (tag: { monitorId: string; appId: string }) => boolean): Promise<void> {
    return this.spawns.settle(match);
  }

  /**
   * Drop every record without disposing anything — the pool's `cleanup()` has taken a
   * snapshot and is about to dispose them all itself.
   */
  clear(): void {
    this.records.clear();
  }
}
