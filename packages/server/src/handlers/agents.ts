/**
 * Agents domain handlers for the verb layer.
 *
 * Maps agent operations to the verb layer:
 *
 *   list('yaar://sessions/current/agents')                         → list all active agents
 *   read('yaar://sessions/current/agents/{agentId}')               → agent info
 *   invoke('yaar://sessions/current/agents/{agentId}', { action }) → interrupt / relay
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri, ResolvedSession } from './uri-resolve.js';
import { getAgentId, getMonitorId } from '../agents/session.js';
import { ok, okJson, error, getActivePool, requireAction } from './utils.js';

function assertSessionAgents(resolved: ResolvedUri): asserts resolved is ResolvedSession {
  if (resolved.kind !== 'session' || (resolved as ResolvedSession).subKind !== 'agents')
    throw new Error(`Expected session agents URI, got ${resolved.kind}`);
}

function getPool() {
  return getActivePool();
}

export function registerAgentsHandlers(registry: ResourceRegistry): void {
  // ── yaar://sessions/current/agents — list all agents ──
  registry.register('yaar://sessions/current/agents', {
    description: 'List all active agents (main, window, ephemeral).',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const pool = getPool();
      if (!pool) return ok('No agents — session not initialized.');

      const stats = pool.getStats();
      return okJson({
        totalAgents: stats.totalAgents,
        idleAgents: stats.idleAgents,
        busyAgents: stats.busyAgents,
        mainAgent: stats.mainAgent,
        windowAgents: stats.windowAgents,
        ephemeralAgents: stats.ephemeralAgents,
      });
    },
  });

  // ── yaar://sessions/current/agents/* — agent instance operations ──
  registry.register('yaar://sessions/current/agents/*', {
    description:
      'Agent instance. Read for agent info, invoke to interrupt or relay a message to main.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['interrupt', 'relay'] },
        message: { type: 'string', description: 'Message to relay (for relay action)' },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertSessionAgents(resolved);
      if (!resolved.id) return error('Agent ID required.');
      const pool = getPool();
      if (!pool) return error('No agents — session not initialized.');

      const exists = pool.hasAgent(resolved.id);
      if (!exists) return error(`Agent "${resolved.id}" not found.`);

      return okJson({ id: resolved.id, exists: true });
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      assertSessionAgents(resolved);
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;

      if (payload!.action === 'interrupt') {
        const pool = getPool();
        if (!pool) return error('No agents — session not initialized.');

        if (resolved.id) {
          const interrupted = await pool.interruptAgent(resolved.id);
          if (!interrupted) return error(`Agent "${resolved.id}" not found or not running.`);
          return ok(`Interrupted agent "${resolved.id}".`);
        }

        // No specific agent — interrupt all
        await pool.interruptAll();
        return ok('Interrupted all agents.');
      }

      if (payload!.action === 'relay') {
        if (!resolved.id || resolved.id !== 'main')
          return error('Relay is only supported on yaar://sessions/current/agents/main.');
        if (typeof payload!.message !== 'string' || !payload!.message)
          return error('"message" (string) is required for relay.');

        const pool = getPool();
        if (!pool) return error('Agent pool not initialized.');

        const agentId = getAgentId() ?? 'unknown';
        const monitorId = getMonitorId() ?? '0';
        const messageId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const content = `<relay from="${agentId}">\n${payload!.message}\n</relay>`;

        pool
          .handleTask({ type: 'main', messageId, content, monitorId })
          .catch((err: unknown) => console.error('[relay_to_main] Failed:', err));

        return ok(`Relayed to main agent (messageId: ${messageId}).`);
      }

      return error(`Unknown action "${payload!.action}".`);
    },
  });
}
