/**
 * App badge tool - set badge count on desktop app icons.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OSAction } from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import { ok } from '../utils.js';

export function registerBadgeTool(server: McpServer): void {
  server.registerTool(
    'set_app_badge',
    {
      description:
        'Set a badge count on a desktop app icon. Use to indicate new content or pending items. Set count to 0 to clear the badge.',
      inputSchema: {
        appId: z.string().describe('App ID (folder name in apps/)'),
        count: z.number().int().min(0).describe('Badge count (0 to clear)'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'app.badge',
        appId: args.appId,
        count: args.count,
      };

      actionEmitter.emitAction(osAction);
      return ok(
        args.count > 0
          ? `Badge set to ${args.count} on app "${args.appId}"`
          : `Badge cleared on app "${args.appId}"`,
      );
    },
  );
}
