/**
 * Window notification tools - show_notification, dismiss_notification.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OSAction } from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import { ok } from '../utils.js';

export function registerNotificationTools(server: McpServer): void {
  // show_notification
  server.registerTool(
    'show_notification',
    {
      description:
        'Show a persistent notification that requires manual dismissal. Use for important alerts that should stay visible.',
      inputSchema: {
        id: z.string().describe('Unique notification ID'),
        title: z.string().describe('Notification title'),
        body: z.string().describe('Notification body text'),
        icon: z.string().optional().describe('Optional icon name'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'notification.show',
        id: args.id,
        title: args.title,
        body: args.body,
        icon: args.icon,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Notification "${args.title}" shown`);
    }
  );

  // dismiss_notification
  server.registerTool(
    'dismiss_notification',
    {
      description: 'Dismiss a notification by ID',
      inputSchema: {
        id: z.string().describe('Notification ID to dismiss'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'notification.dismiss',
        id: args.id,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Notification ${args.id} dismissed`);
    }
  );
}
