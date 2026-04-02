/**
 * Sessions domain handlers for the verb layer.
 *
 * Maps live session operations to the verb layer:
 *
 *   read('yaar://sessions/current')              → system info
 *   invoke('yaar://sessions/current', { ... })   → memorize
 *   read('yaar://sessions/current/monitors')     → list monitors
 *   read('yaar://sessions/current/context')       → current context tape summary
 *
 * Historical session log browsing is in handlers/history.ts (yaar://history/).
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri, ResolvedSession } from './uri-resolve.js';
import { ok, okJsonResource, okLinks, error, getActiveSession } from './utils.js';
import { getSessionId, getMonitorId } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import { getBrowserPool } from '../lib/browser/index.js';
import {
  listMonitors,
  getMonitorStatus,
  controlMonitor,
  disposeMonitor,
} from '../features/session/monitors.js';
import { memorize } from '../features/session/memorize.js';

export function registerSessionHandlers(registry: ResourceRegistry): void {
  // ── yaar:// — session root overview ──
  registry.register('yaar://', {
    description:
      'Session root. Read for an overview of the current session and available namespaces.',
    verbs: ['describe', 'read', 'list'],

    async read(): Promise<VerbResult> {
      const sid = getSessionId();
      const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
      const pool = session?.getPool();
      const stats = pool?.getStats();
      const browserPool = getBrowserPool();

      return okJsonResource('yaar://', {
        sessionId: sid ?? session?.sessionId ?? null,
        platform: process.platform,
        uptime: Math.floor(process.uptime()),
        agents: stats
          ? {
              total: stats.totalAgents,
              idle: stats.idleAgents,
              busy: stats.busyAgents,
            }
          : null,
        windows: session?.windowState.listWindows().length ?? 0,
        browsers: browserPool.getAllSessions().size,
      });
    },

    async list(): Promise<VerbResult> {
      return okLinks([
        { uri: 'yaar://apps/', name: 'apps', description: 'Installed apps' },
        { uri: 'yaar://storage/', name: 'storage', description: 'Persistent file storage' },
        { uri: 'yaar://windows/', name: 'windows', description: 'Open windows' },
        { uri: 'yaar://config/', name: 'config', description: 'Configuration' },
        { uri: 'yaar://sessions/', name: 'sessions', description: 'Current session & monitors' },
        { uri: 'yaar://history/', name: 'history', description: 'Past session logs' },
      ]);
    },
  });

  // ── yaar://sessions/current — system info and memorize ──
  registry.register('yaar://sessions/current', {
    description: 'Current session. Read for system info, invoke to memorize notes.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['memorize'] },
        content: { type: 'string', description: 'Note to remember across sessions' },
      },
    },

    async read(): Promise<VerbResult> {
      const info = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memoryUsage: process.memoryUsage(),
        cwd: process.cwd(),
      };
      return okJsonResource('yaar://sessions/current', info);
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'memorize') {
        if (typeof payload.content !== 'string' || !payload.content) {
          return error('"content" (string) is required for memorize.');
        }
        const result = await memorize(payload.content);
        if (!result.success) return error(result.error ?? 'Failed to save memory.');
        return ok(`Memorized: "${payload.content}"`);
      }

      return error(`Unknown action "${payload.action}".`);
    },
  });

  // ── yaar://sessions/current/monitors — list active monitors ──
  registry.register('yaar://sessions/current/monitors', {
    description:
      'Active monitors in the current session. Read for list of monitor IDs and their status.',
    verbs: ['describe', 'read'],

    async read(): Promise<VerbResult> {
      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const monitors = listMonitors(session, pool);
      return okJsonResource('yaar://sessions/current/monitors', {
        currentMonitorId: getMonitorId() ?? '0',
        monitors,
      });
    },
  });

  // ── yaar://sessions/current/monitors/* — individual monitor operations ──
  registry.register('yaar://sessions/current/monitors/*', {
    description:
      'Individual monitor. Read for status, invoke to suspend/resume/interrupt, delete to dispose.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['suspend', 'resume', 'interrupt'] },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const monitorId = sessionResolved.id;
      if (!monitorId) return error('Monitor ID required.');

      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const status = getMonitorStatus(session, pool, monitorId);
      if (!status) return error(`Monitor "${monitorId}" not found.`);
      return okJsonResource(resolved.sourceUri, status);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const monitorId = sessionResolved.id;
      if (!monitorId) return error('Monitor ID required.');
      if (!payload?.action) return error('Payload must include "action".');

      const pool = getActiveSession().getPool();
      if (!pool) return error('Session not initialized.');

      if (!pool.hasMonitorAgent(monitorId)) {
        return error(`Monitor "${monitorId}" not found.`);
      }

      const action = payload.action as string;
      if (action !== 'suspend' && action !== 'resume' && action !== 'interrupt') {
        return error(`Unknown action "${action}". Supported: suspend, resume, interrupt.`);
      }

      const result = await controlMonitor(pool, monitorId, action);
      return result.success ? ok(result.message) : error(result.message);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const monitorId = sessionResolved.id;
      if (!monitorId) return error('Monitor ID required.');

      const pool = getActiveSession().getPool();
      if (!pool) return error('Session not initialized.');

      if (!pool.hasMonitorAgent(monitorId)) {
        return error(`Monitor "${monitorId}" not found.`);
      }

      await disposeMonitor(pool, monitorId);
      return ok(`Monitor "${monitorId}" disposed.`);
    },
  });

  // ── yaar://sessions/current/context — current context tape summary ──
  registry.register('yaar://sessions/current/context', {
    description:
      'Current session context tape. Read for a summary of messages tracked by the context system.',
    verbs: ['describe', 'read'],

    async read(): Promise<VerbResult> {
      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const messages = pool.contextTape.getMessages();
      const windowMessages = pool.contextTape.getMessages({ includeWindows: true });
      const mainMessages = pool.contextTape.getMessages({ includeWindows: false });

      return okJsonResource('yaar://sessions/current/context', {
        totalMessages: messages.length,
        mainMessages: mainMessages.length,
        windowMessages: windowMessages.length - mainMessages.length,
        contextTapeSize: pool.contextTape.length,
        recentMessages: mainMessages.slice(-10).map((m) => ({
          role: m.role,
          source: m.source,
          contentPreview:
            typeof m.content === 'string' ? m.content.slice(0, 200) : '[non-text content]',
        })),
      });
    },
  });
}
