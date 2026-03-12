/**
 * Sessions domain handlers for the verb layer.
 *
 * Maps session and system operations to the verb layer:
 *
 *   read('yaar://sessions/current')              → system info
 *   invoke('yaar://sessions/current', { ... })   → memorize
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error } from './utils.js';
import { configRead, configWrite } from '../storage/storage-manager.js';
import { getSessionId, getMonitorId } from '../agents/session.js';
import { getSessionHub } from '../session/session-hub.js';
import { getBrowserPool } from '../lib/browser/index.js';
import { parseWindowKey } from '@yaar/shared';

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

      return ok(
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      );
    },

    async list(): Promise<VerbResult> {
      return ok(
        JSON.stringify(
          {
            namespaces: [
              'yaar://apps/',
              'yaar://storage/',
              'yaar://sandbox/',
              'yaar://windows/',
              'yaar://config/',
              'yaar://browser/',
              'yaar://sessions/',
            ],
          },
          null,
          2,
        ),
      );
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
      return ok(JSON.stringify(info, null, 2));
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
      const sid = getSessionId();
      const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
      const pool = session?.getPool();
      if (!pool) return error('Session not initialized.');

      const monitorIds = pool.getMainAgentMonitorIds();
      const allWindows = session!.windowState.listWindows();

      const monitors = monitorIds.map((id) => {
        const windows = allWindows.filter((w) => {
          const parsed = parseWindowKey(w.id);
          return parsed?.monitorId === id;
        });
        return {
          monitorId: id,
          hasMainAgent: pool.hasMainAgent(id),
          windowCount: windows.length,
        };
      });

      return ok(
        JSON.stringify(
          {
            currentMonitorId: getMonitorId() ?? '0',
            monitors,
          },
          null,
          2,
        ),
      );
    },
  });
}
