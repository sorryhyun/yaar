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
import { executeSessionAction } from '../features/agents/session-actions.js';
import { relayToMonitor } from '../features/agents/relay.js';

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
    description: 'List all active agents (monitor, app, ephemeral).',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const pool = getPool();
      if (!pool)
        return okJson({
          totalAgents: 0,
          idleAgents: 0,
          busyAgents: 0,
          monitorAgent: [],
          appAgents: 0,
          ephemeralAgents: [],
        });

      const stats = pool.getStats();
      return okJson({
        totalAgents: stats.totalAgents,
        idleAgents: stats.idleAgents,
        busyAgents: stats.busyAgents,
        monitorAgent: stats.monitorAgent,
        appAgents: stats.appAgents,
        ephemeralAgents: stats.ephemeralAgents,
        sessionAgent: stats.sessionAgent,
      });
    },
  });

  // ── yaar://sessions/current/agents/* — agent instance operations ──
  registry.register('yaar://sessions/current/agents/*', {
    description:
      'Agent instance. Read for agent info, invoke to interrupt, relay, or invoke the session agent.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['interrupt', 'relay', 'audit', 'coordinate', 'query'],
        },
        message: { type: 'string', description: 'Message to relay (for relay action)' },
        plan: { type: 'string', description: 'Coordination plan (for coordinate action)' },
        question: {
          type: 'string',
          description: 'Question about session state (for query action)',
        },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      assertSessionAgents(resolved);
      if (!resolved.id) return error('Agent ID required.');

      // Session agent status
      if (resolved.id === 'session') {
        const pool = getPool();
        if (!pool) return error('Session not initialized.');

        const agent = pool.agentPool.getSessionAgent();
        return okJson({
          id: 'session',
          exists: agent !== null,
          busy: agent ? agent.session.isRunning() || agent.currentRole !== null : false,
          instanceId: agent?.instanceId ?? null,
        });
      }

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

      const action = payload!.action as string;

      // ── Session agent actions ──
      if (resolved.id === 'session') {
        if (action === 'audit' || action === 'coordinate' || action === 'query') {
          const pool = getPool();
          if (!pool) return error('Session not initialized.');

          const result = await executeSessionAction(pool, action, {
            plan: payload!.plan as string | undefined,
            question: payload!.question as string | undefined,
          });
          return result.success
            ? ok(`Session agent completed "${action}" action.`)
            : error(result.error!);
        }
      }

      if (action === 'interrupt') {
        const pool = getPool();
        if (!pool) return error('No agents — session not initialized.');

        if (resolved.id) {
          // Session agent interrupt
          if (resolved.id === 'session') {
            const agent = pool.agentPool.getSessionAgent();
            if (!agent || !agent.session.isRunning()) return error('Session agent is not running.');
            await agent.session.interrupt();
            return ok('Interrupted session agent.');
          }

          const interrupted = await pool.interruptAgent(resolved.id);
          if (!interrupted) return error(`Agent "${resolved.id}" not found or not running.`);
          return ok(`Interrupted agent "${resolved.id}".`);
        }

        // No specific agent — interrupt all
        await pool.interruptAll();
        return ok('Interrupted all agents.');
      }

      if (action === 'relay') {
        if (!resolved.id || resolved.id !== 'monitor')
          return error('Relay is only supported on yaar://sessions/current/agents/monitor.');
        if (typeof payload!.message !== 'string' || !payload!.message)
          return error('"message" (string) is required for relay.');

        const pool = getPool();
        if (!pool) return error('Agent pool not initialized.');

        const agentId = getAgentId() ?? 'unknown';
        const monitorId = getMonitorId() ?? '0';
        const messageId = relayToMonitor(pool, agentId, monitorId, payload!.message as string);

        return ok(`Relayed to monitor agent (messageId: ${messageId}).`);
      }

      return error(`Unknown action "${action}".`);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertSessionAgents(resolved);

      if (resolved.id === 'session') {
        const pool = getPool();
        if (!pool) return error('Session not initialized.');

        if (!pool.agentPool.hasSessionAgent()) {
          return error('Session agent does not exist.');
        }

        await pool.disposeSessionAgent();
        return ok('Session agent disposed.');
      }

      return error('Delete is only supported on yaar://sessions/current/agents/session.');
    },
  });
}
