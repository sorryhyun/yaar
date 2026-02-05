/**
 * MCP tools for the action reload cache.
 *
 * Provides tools for replaying cached action sequences.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../mcp/utils.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import { getAgentId } from '../agents/session.js';
import type { ReloadCache } from './cache.js';
import type { CacheEntry } from './types.js';

export function registerReloadTools(server: McpServer, getCache: () => ReloadCache, getWindowState: () => WindowStateRegistry): void {
  // reload_cached - replay a cached action sequence
  server.registerTool(
    'reload_cached',
    {
      description:
        'Replay a cached action sequence from a previous identical interaction. ' +
        'Use this when <reload_options> are provided and the cached sequence matches your intent. ' +
        'Much faster than recreating actions from scratch.',
      inputSchema: {
        cacheId: z.string().describe('The cache entry ID to replay (from reload_options)'),
      },
    },
    async (args) => {
      const cache = getCache();
      const entry = cache.getEntry(args.cacheId);
      if (!entry) {
        return ok('Cache entry not found. Proceed manually.');
      }

      // Validate required windows still exist
      if (entry.requiredWindowIds) {
        for (const windowId of entry.requiredWindowIds) {
          if (!getWindowState().hasWindow(windowId)) {
            cache.markFailed(entry.id);
            return ok(`Cache invalid: window "${windowId}" no longer exists. Proceed manually.`);
          }
        }
      }

      // Replay actions
      const agentId = getAgentId();
      try {
        for (const action of entry.actions) {
          // Substitute current agentId for lock/unlock actions
          let replayAction = action;
          if (
            (action.type === 'window.lock' || action.type === 'window.unlock') &&
            agentId
          ) {
            replayAction = { ...action, agentId };
          }

          actionEmitter.emitAction(replayAction, undefined, agentId);
        }

        cache.markUsed(entry.id);

        // Emit feedback toast so user can report if the replay didn't work
        actionEmitter.emitAction(
          {
            type: 'toast.show',
            id: `reload-feedback-${entry.id}`,
            message: 'Loaded from cache',
            variant: 'info',
            duration: 8000,
            action: { label: "Didn't work?", eventId: entry.id },
          },
          undefined,
          agentId,
        );

        return ok(`Replayed ${entry.actions.length} actions from cache "${entry.label}".`);
      } catch (err) {
        cache.markFailed(entry.id);
        return ok(`Cache replay failed: ${err instanceof Error ? err.message : String(err)}. Proceed manually.`);
      }
    }
  );

  // list_reload_options - list available cached sequences
  server.registerTool(
    'list_reload_options',
    {
      description:
        'List available cached action sequences. ' +
        'Usually not needed as options are injected into the message automatically.',
    },
    async () => {
      const entries = getCache().listEntries();
      if (entries.length === 0) {
        return ok('No cached action sequences available.');
      }

      const lines = entries
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, 10)
        .map((e: CacheEntry) =>
          `- ${e.id}: "${e.label}" (used ${e.useCount}x, ${e.actions.length} actions)`
        );

      return ok(`Cached action sequences:\n${lines.join('\n')}`);
    }
  );
}
