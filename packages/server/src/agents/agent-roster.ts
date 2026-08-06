/**
 * What one pooled agent is, how it is addressed, and how the roster is rendered.
 *
 * Lifted out of `agent-pool.ts` because none of it is lifecycle: given the agents, every
 * function here is a pure projection. The pool decides who exists; this decides how they
 * are named, keyed, and nested. Keeping the two apart is what lets `AgentPool` be read as
 * create/dispose/limit and nothing else.
 *
 * The composite keys belong here for the same reason {@link buildAgentTree} does — they
 * *are* the ownership tree, written as strings: `monitorId` extends to
 * `monitorId::appId` extends to `monitorId::appId::subId`, and the tree builder reads
 * them back. Three modules mint them (the pool, the sub-agent registry, the app task
 * processor) and a fourth parses them; one definition is what keeps the extension rule
 * true.
 */

import type { AgentSession } from './agent-session.js';
import type { TokenUsage } from '../providers/types.js';

/**
 * Internal pooled agent representation.
 */
export interface PooledAgent {
  session: AgentSession;
  id: number;
  instanceId: string;
  /**
   * When this agent last ran a turn or was handed to a caller. Read only by the
   * app-agent idle reaper (`AgentPool.reapIdleAppAgents`); every other tier
   * writes it and nothing reads it, which is fine — the field is the reaper's clock,
   * and a tier with another reclaim path does not need one.
   */
  lastUsed: number;
  currentRole: string | null; // 'monitor-{messageId}' or 'app-{id}' when active
}

/**
 * An agent is busy while its provider is streaming or a role is assigned to it.
 *
 * A free function because three separate readers ask it — the pool's own reaper and
 * stats, the roster below, and the sub-agent registry — and "busy" must mean the same
 * thing to all of them.
 */
export function isAgentBusy(agent: PooledAgent): boolean {
  return agent.session.isRunning() || agent.currentRole !== null;
}

/** One live agent, as reported by `listAgents()`. */
export interface AgentEntry {
  /** instanceId — stable across turns; accepted by `interruptByIdOrRole`. */
  id: string;
  /**
   * Which tier. `persona` is the sub-agent tier's spelling — shipped vocabulary, and
   * the same word the URI segment and the spawn param use.
   */
  type: 'session' | 'monitor' | 'app' | 'ephemeral' | 'persona';
  /** Human-readable name: the monitorId, the appId, or the current role. */
  label: string;
  busy: boolean;
  monitorId?: string;
  appId?: string;
  /** Sub-agents only — the id its owning app spawned it under. */
  subId?: string;
  /** Lifetime token consumption. `inputTokens` is fresh input — see {@link TokenUsage}. */
  usage: TokenUsage;
}

/**
 * One agent as the pool's single traversal yields it: the record, its tier, and whatever
 * ids place it in the tree.
 */
export interface RosterMember {
  agent: PooledAgent;
  type: AgentEntry['type'];
  monitorId?: string;
  appId?: string;
  subId?: string;
}

/**
 * One node of the roster rendered as the tree it already is — see {@link buildAgentTree}.
 *
 * `id` is null for a **vacant owner slot**: ownership follows the key, not the
 * instance, so an app's sub-agents hang under `monitorId::appId` whether or not that
 * app ever grew an agent of its own (a persona is spawned by an app's *iframe*, which
 * needs no app agent to exist).
 */
export interface AgentTreeNode {
  /** instanceId, or null when this node is an owner slot with nobody in it. */
  id: string | null;
  type: AgentEntry['type'];
  label: string;
  busy?: boolean;
  children?: AgentTreeNode[];
}

/**
 * Name every live agent, one entry each, in the order the pool yields them:
 * session → monitor → app → persona → ephemeral. `getStats()` only counts them; this
 * names them, so a caller can show a roster and interrupt a specific agent by `id`
 * (see `AgentPool.interruptByIdOrRole`).
 */
export function listAgents(members: Iterable<RosterMember>): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const { agent, type, monitorId, appId, subId } of members) {
    const id = agent.instanceId;
    const busy = isAgentBusy(agent);
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
          label: `${subId} · ${appId} (monitor ${monitorId})`,
          busy,
          monitorId,
          appId,
          subId,
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

/**
 * App agents are scoped to the monitor that owns their windows, so two monitors
 * running the same app each get their own agent (and neither can see the other's
 * context). This is the composite key; `::` cannot occur in a monitorId (numeric)
 * or an appId (a directory name).
 */
export function appAgentKey(monitorId: string, appId: string): string {
  return `${monitorId}::${appId}`;
}

export function parseAppKey(key: string): { monitorId: string; appId: string } {
  const idx = key.indexOf('::');
  return { monitorId: key.slice(0, idx), appId: key.slice(idx + 2) };
}

/**
 * Sub-agents extend the app key with their own id. The parts are never parsed back
 * out — `SubAgent` carries them as fields — so the key only has to be unique,
 * and `::` still cannot occur in any of the three components (numeric monitorId,
 * directory-name appId, `PERSONA_ID_RE` subId).
 */
export function subAgentKey(monitorId: string, appId: string, subId: string): string {
  return `${monitorId}::${appId}::${subId}`;
}

/**
 * Re-shape a flat roster into the ownership tree, session at the root.
 *
 * Nothing here is new information — every entry already carries its `monitorId`,
 * `appId`, and `subId`, so the parentage was always in the data. This states it,
 * which is the whole point: a reader of `yaar://session/agents` should be able to see
 * that disposing a monitor takes its apps and their sub-agents with it.
 *
 * Ephemerals sit at the root: they are monitor-tier helpers keyed by nothing (the
 * one anomaly the tree hasn't absorbed yet), so there is no owner to place them under.
 */
export function buildAgentTree(entries: AgentEntry[]): AgentTreeNode[] {
  const roots: AgentTreeNode[] = [];
  const monitorNodes = new Map<string, AgentTreeNode>();
  const appNodes = new Map<string, AgentTreeNode>();

  const kids = (node: AgentTreeNode): AgentTreeNode[] => (node.children ??= []);
  const leaf = (e: AgentEntry): AgentTreeNode => ({
    id: e.id,
    type: e.type,
    label: e.label,
    busy: e.busy,
  });
  /** Fill a slot that was created vacant, keeping its place among its siblings. */
  const occupy = (node: AgentTreeNode, e: AgentEntry): void => {
    node.id = e.id;
    node.label = e.label;
    node.busy = e.busy;
  };

  // Pulled out first so monitors have somewhere to attach regardless of roster order.
  const sessionEntry = entries.find((e) => e.type === 'session');
  const sessionNode = sessionEntry ? leaf(sessionEntry) : undefined;
  if (sessionNode) roots.push(sessionNode);
  const topLevel = (): AgentTreeNode[] => (sessionNode ? kids(sessionNode) : roots);

  const monitorSlot = (monitorId: string): AgentTreeNode => {
    let node = monitorNodes.get(monitorId);
    if (!node) {
      node = { id: null, type: 'monitor', label: `monitor ${monitorId}` };
      monitorNodes.set(monitorId, node);
      topLevel().push(node);
    }
    return node;
  };
  const appSlot = (monitorId: string, appId: string): AgentTreeNode => {
    const key = appAgentKey(monitorId, appId);
    let node = appNodes.get(key);
    if (!node) {
      node = { id: null, type: 'app', label: `${appId} (monitor ${monitorId})` };
      appNodes.set(key, node);
      kids(monitorSlot(monitorId)).push(node);
    }
    return node;
  };

  for (const e of entries) {
    if (e === sessionEntry) continue;
    if (e.type === 'monitor' && e.monitorId) occupy(monitorSlot(e.monitorId), e);
    else if (e.type === 'app' && e.monitorId && e.appId) occupy(appSlot(e.monitorId, e.appId), e);
    else if (e.type === 'persona' && e.monitorId && e.appId)
      kids(appSlot(e.monitorId, e.appId)).push(leaf(e));
    // Ephemerals, and anything missing the ids that would place it, stay at the top.
    else topLevel().push(leaf(e));
  }

  return roots;
}
