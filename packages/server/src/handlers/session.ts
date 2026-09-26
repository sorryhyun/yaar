/**
 * Sessions domain handlers for the verb layer.
 *
 * Maps live session operations to the verb layer:
 *
 *   read('yaar://session')              → system info
 *   read('yaar://session/monitors')     → list monitors
 *   read('yaar://session/context')       → current context tape summary
 *
 * Historical session log browsing is in handlers/history.ts (yaar://history/).
 *
 * Every yaar://session registration is session-principal only. None of them says so:
 * `ResourceRegistry.register` derives it from the prefix, so a new one cannot forget.
 */

import type { ResourceRegistry } from './uri-registry.js';
import { ok, okJsonResource, okLinks, error, type VerbResult } from '../lib/verb-result.js';
import { getActiveSession } from './utils.js';
import type { ResolvedUri, ResolvedSession } from './uri-resolve.js';
import { defineActions, summarizeActions } from './define-actions.js';
import { getSessionId, requireMonitorId } from '../agents/agent-context.js';
import { getSessionHub } from '../session/session-hub.js';
import { getHeadlessBrowser } from '../lib/browser/index.js';
import {
  listMonitors,
  getMonitorStatus,
  controlMonitor,
  disposeMonitor,
} from '../features/session/monitors.js';
import { sessionBrowserRead, sessionBrowserInvoke } from '../features/session/browser.js';
import { BROWSER_ACTIONS } from '../features/browser/actions.js';
import type { ContextPool } from '../agents/context-pool.js';

function monitorAction(action: 'suspend' | 'resume' | 'interrupt', description: string) {
  return {
    description,
    run: async ({ pool, monitorId }: { pool: ContextPool; monitorId: string }) => {
      const result = await controlMonitor(pool, monitorId, action);
      return result.success ? ok(result.message) : error(result.message);
    },
  };
}

const monitorActions = defineActions<{ pool: ContextPool; monitorId: string }>({
  suspend: monitorAction('suspend', "Hold the monitor's queued messages until resumed."),
  resume: monitorAction('resume', 'Resume a suspended monitor and drain its queue.'),
  interrupt: monitorAction('interrupt', "Interrupt the monitor agent's running turn."),
});

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
      const browserPool = getHeadlessBrowser();

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
        { uri: 'yaar://session/', name: 'session', description: 'Current session & monitors' },
        {
          uri: 'yaar://user/',
          name: 'user',
          description: 'User-facing interactions (notifications, prompts)',
        },
        { uri: 'yaar://history/', name: 'history', description: 'Past session logs' },
      ]);
    },
  });

  // ── yaar://session — system info ──
  registry.register('yaar://session', {
    description: 'Current session. Read for system info.',
    verbs: ['describe', 'read'],

    async read(): Promise<VerbResult> {
      const info = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memoryUsage: process.memoryUsage(),
        cwd: process.cwd(),
      };
      return okJsonResource('yaar://session', info);
    },
  });

  // ── yaar://session/browser — drive the user's REAL browser (deputy) ──
  registry.register('yaar://session/browser', {
    description:
      "Drive the user's own browser as their deputy — real Chrome, real cookies and logins " +
      '(not the headless sandbox behind /api/browser). Read to list open tabs; invoke with ' +
      '{ action, ... } to navigate/click/type/extract/screenshot, etc. Session agent only.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...BROWSER_ACTIONS],
        },
        browserId: { type: 'string', description: 'Tab id (default "0").' },
        url: { type: 'string', description: 'URL for open/navigate.' },
        selector: { type: 'string' },
        text: { type: 'string' },
      },
    },

    async read(): Promise<VerbResult> {
      return sessionBrowserRead();
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      return sessionBrowserInvoke(payload);
    },
  });

  // ── yaar://session/monitors — list active monitors ──
  registry.register('yaar://session/monitors', {
    description:
      'Active monitors in the current session. Read for list of monitor IDs and their status.',
    verbs: ['describe', 'read'],

    async read(): Promise<VerbResult> {
      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const monitors = listMonitors(session, pool);
      return okJsonResource('yaar://session/monitors', {
        currentMonitorId: requireMonitorId(),
        monitors,
      });
    },
  });

  // ── yaar://session/monitors/* — individual monitor operations ──
  registry.register('yaar://session/monitors/*', {
    description:
      'Individual monitor. Read for status, invoke to suspend/resume/interrupt, delete to dispose.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { ...monitorActions.schema, description: summarizeActions(monitorActions) },
      },
    },

    async exists(resolved: ResolvedUri): Promise<boolean> {
      const monitorId = (resolved as ResolvedSession).id;
      if (!monitorId) return false;
      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return false;
      return getMonitorStatus(session, pool, monitorId) !== null;
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

      if (!pool.agentPool.hasMonitorAgent(monitorId)) {
        return error(`Monitor "${monitorId}" not found.`);
      }

      return monitorActions.dispatch(payload.action as string, { pool, monitorId });
    },

    // Deletion is the session's, not the pool's — a monitor exists whether or not it has
    // ever been messaged, and removing its agent is only one of the four things deleting
    // one means. See `disposeMonitor`.
    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const sessionResolved = resolved as ResolvedSession;
      const monitorId = sessionResolved.id;
      if (!monitorId) return error('Monitor ID required.');

      const result = await disposeMonitor(getActiveSession(), monitorId);
      return result.success ? ok(result.message) : error(result.message);
    },
  });

  // ── yaar://session/context — current context tape summary ──
  registry.register('yaar://session/context', {
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

      return okJsonResource('yaar://session/context', {
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
