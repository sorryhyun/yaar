/**
 * Agents domain handlers for the verb layer.
 *
 * Maps agent operations to the verb layer:
 *
 *   list('yaar://agents/')                         → list all active agents
 *   read('yaar://agents/{agentId}')               → agent info
 *   invoke('yaar://agents/{agentId}', { action })  → interrupt
 */

import type { ResourceRegistry, VerbResult } from '../../uri/registry.js';
import type { ResolvedUri, ResolvedAgent } from '../../uri/resolve.js';
import { getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import { ok, error } from '../utils.js';

function assertAgent(resolved: ResolvedUri): asserts resolved is ResolvedAgent {
  if (resolved.kind !== 'agent') throw new Error(`Expected agent URI, got ${resolved.kind}`);
}

function getPool() {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  if (!session) throw new Error('No active session.');
  return session.getPool();
}

export function registerAgentsHandlers(registry: ResourceRegistry): void {
  // ── yaar://agents — list all agents ──
  registry.register('yaar://agents', {
    description: 'List all active agents (main, window, ephemeral).',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const pool = getPool();
      if (!pool) return ok('No agents — session not initialized.');

      const stats = pool.getStats();
      return ok(
        JSON.stringify(
          {
            totalAgents: stats.totalAgents,
            idleAgents: stats.idleAgents,
            busyAgents: stats.busyAgents,
            mainAgent: stats.mainAgent,
            windowAgents: stats.windowAgents,
            ephemeralAgents: stats.ephemeralAgents,
          },
          null,
          2,
        ),
      );
    },
  });

  // ── yaar://agents/* — agent instance operations ──
  registry.register('yaar://agents/*', {
    description: 'Agent instance. Read for agent info, invoke to interrupt.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['interrupt'] },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertAgent(resolved);
      if (!resolved.id) return error('Agent ID required.');
      const pool = getPool();
      if (!pool) return error('No agents — session not initialized.');

      const exists = pool.hasAgent(resolved.id);
      if (!exists) return error(`Agent "${resolved.id}" not found.`);

      return ok(JSON.stringify({ id: resolved.id, exists: true }, null, 2));
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      assertAgent(resolved);
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'interrupt') {
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

      return error(`Unknown action "${payload.action}".`);
    },
  });
}
