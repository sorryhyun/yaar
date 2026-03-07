/**
 * Sessions domain handlers for the verb layer.
 *
 * Maps session and system operations to the verb layer:
 *
 *   read('yaar://sessions/current')              → system info
 *   invoke('yaar://sessions/current', { ... })   → memorize
 */

import type { ResourceRegistry, VerbResult } from '../../uri/registry.js';
import type { ResolvedUri } from '../../uri/resolve.js';
import { ok, error } from '../utils.js';
import { configRead, configWrite } from '../../storage/storage-manager.js';

export function registerSessionHandlers(registry: ResourceRegistry): void {
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
}
