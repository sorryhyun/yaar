/**
 * Sessions domain handlers for the verb layer.
 *
 * Maps session and system operations to the verb layer:
 *
 *   read('yaar://sessions/current')              → system info
 *   invoke('yaar://sessions/current', { ... })   → memorize
 *   list('yaar://sessions/')                       → list all sessions
 *   read('yaar://sessions/{id}')                  → read a specific session transcript
 *   read('yaar://sessions/current/context')       → current context tape summary
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri, ResolvedSession } from './uri-resolve.js';
import { ok, okJson, error, getActiveSession } from './utils.js';
import { configRead, configWrite } from '../storage/storage-manager.js';
import { getSessionId, getMonitorId } from '../agents/session.js';
import { getSessionHub } from '../session/session-hub.js';
import { getBrowserPool } from '../lib/browser/index.js';
import { parseWindowKey } from '@yaar/shared';
import { listSessions, readSessionTranscript } from '../logging/session-reader.js';

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

      return okJson({
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
      return okJson({
        namespaces: [
          'yaar://apps/',
          'yaar://storage/',
          'yaar://windows/',
          'yaar://config/',
          'yaar://browser/',
          'yaar://sessions/',
        ],
      });
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
      return okJson(info);
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'memorize') {
        if (typeof payload.content !== 'string' || !payload.content) {
          return error('"content" (string) is required for memorize.');
        }
        const existing = await configRead('memory.md');
        const current = existing.success ? (existing.content ?? '') : '';
        const updated = current ? current.trimEnd() + '\n' + payload.content : payload.content;
        const result = await configWrite('memory.md', updated + '\n');
        if (!result.success) return error(`Failed to save memory: ${result.error}`);
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

      const monitorIds = pool.getMonitorAgentIds();
      const allWindows = session.windowState.listWindows();

      const monitors = monitorIds.map((id) => {
        const windows = allWindows.filter((w) => {
          const parsed = parseWindowKey(w.id);
          return parsed?.monitorId === id;
        });
        return {
          monitorId: id,
          hasMonitorAgent: pool.hasMonitorAgent(id),
          windowCount: windows.length,
        };
      });

      return okJson({
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

      if (!pool.hasMonitorAgent(monitorId)) {
        return error(`Monitor "${monitorId}" not found.`);
      }

      const allWindows = session.windowState.listWindows();
      const windows = allWindows.filter((w) => {
        const parsed = parseWindowKey(w.id);
        return parsed?.monitorId === monitorId;
      });

      const agentPool = pool.agentPool;
      const agent = agentPool.getMonitorAgent(monitorId);
      const isBusy = agentPool.isMonitorAgentBusy(monitorId);
      const isSuspended = pool.isMonitorSuspended(monitorId);

      return okJson({
        monitorId,
        agent: agent
          ? {
              instanceId: agent.instanceId,
              busy: isBusy,
              currentRole: agent.currentRole,
            }
          : null,
        suspended: isSuspended,
        windowCount: windows.length,
        windows: windows.map((w) => ({ id: w.id, title: w.title })),
      });
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const monitorId = sessionResolved.id;
      if (!monitorId) return error('Monitor ID required.');
      if (!payload?.action) return error('Payload must include "action".');

      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      if (!pool.hasMonitorAgent(monitorId)) {
        return error(`Monitor "${monitorId}" not found.`);
      }

      const action = payload.action as string;

      if (action === 'suspend') {
        const success = pool.suspendMonitor(monitorId);
        return success ? ok(`Monitor "${monitorId}" suspended.`) : error(`Failed to suspend.`);
      }

      if (action === 'resume') {
        const success = pool.resumeMonitor(monitorId);
        return success
          ? ok(`Monitor "${monitorId}" resumed.`)
          : error(`Monitor "${monitorId}" is not suspended.`);
      }

      if (action === 'interrupt') {
        const agent = pool.agentPool.getMonitorAgent(monitorId);
        if (!agent || !agent.session.isRunning()) {
          return error(`Monitor "${monitorId}" is not running.`);
        }
        await agent.session.interrupt();
        return ok(`Monitor "${monitorId}" interrupted.`);
      }

      return error(`Unknown action "${action}". Supported: suspend, resume, interrupt.`);
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

      await pool.removeMonitorAgent(monitorId);
      return ok(`Monitor "${monitorId}" disposed.`);
    },
  });

  // ── yaar://sessions/ — list all sessions ──
  registry.register('yaar://sessions/', {
    description: 'All sessions. List to see past sessions, read a specific one by ID.',
    verbs: ['describe', 'list', 'read'],

    async list(): Promise<VerbResult> {
      const sessions = await listSessions();
      const pool = getActiveSession().getPool();
      const currentLogId = pool?.getLogSessionId();
      return okJson({
        currentSessionId: currentLogId ?? null,
        count: sessions.length,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          createdAt: s.metadata.createdAt,
          provider: s.metadata.provider,
          lastActivity: s.metadata.lastActivity,
          agentCount: Object.keys(s.metadata.agents).length,
        })),
      });
    },

    async read(): Promise<VerbResult> {
      const sessions = await listSessions();
      const pool = getActiveSession().getPool();
      const currentLogId = pool?.getLogSessionId();
      return okJson({
        currentSessionId: currentLogId ?? null,
        totalSessions: sessions.length,
        latest: sessions.slice(0, 5).map((s) => ({
          sessionId: s.sessionId,
          createdAt: s.metadata.createdAt,
          provider: s.metadata.provider,
        })),
      });
    },
  });

  // ── yaar://sessions/* — read a specific session transcript ──
  registry.register('yaar://sessions/*', {
    description: 'Read a specific session transcript by session ID.',
    verbs: ['describe', 'read'],

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const logId = sessionResolved.id ?? sessionResolved.resource;
      if (!logId || logId === 'current')
        return error(
          'Session ID is required. Use list("yaar://sessions/") to see available sessions.',
        );

      const transcript = await readSessionTranscript(logId);
      if (transcript === null) return error(`Session "${logId}" not found.`);

      return ok(transcript);
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

      return okJson({
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
