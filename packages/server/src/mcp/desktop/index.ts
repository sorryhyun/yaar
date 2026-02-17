/**
 * Desktop tools — create, remove, update, and list desktop shortcuts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import {
  readShortcuts,
  addShortcut,
  removeShortcut,
  updateShortcut,
} from '../../storage/shortcuts.js';
import type { DesktopShortcut } from '@yaar/shared';

export const DESKTOP_TOOL_NAMES = [
  'mcp__system__create_shortcut',
  'mcp__system__remove_shortcut',
  'mcp__system__update_shortcut',
  'mcp__system__list_shortcuts',
] as const;

export function registerDesktopTools(server: McpServer): void {
  server.registerTool(
    'create_shortcut',
    {
      description:
        'Create a desktop shortcut. Shortcuts appear on the desktop and can link to files, URLs, or custom actions.',
      inputSchema: {
        label: z.string().describe('Display name for the shortcut'),
        icon: z.string().describe('Emoji icon or storage image path'),
        iconType: z.enum(['emoji', 'image']).optional().describe('Icon type (default: emoji)'),
        type: z.enum(['file', 'url', 'action']).describe('Shortcut type'),
        target: z
          .string()
          .describe('Storage path (file), URL (url), or action identifier (action)'),
      },
    },
    async (args) => {
      const shortcut: DesktopShortcut = {
        id: `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: args.label,
        icon: args.icon,
        iconType: args.iconType,
        type: args.type,
        target: args.target,
        createdAt: Date.now(),
      };
      await addShortcut(shortcut);
      actionEmitter.emitAction({ type: 'desktop.createShortcut', shortcut });
      return ok(`Shortcut created: "${shortcut.label}" (${shortcut.id})`);
    },
  );

  server.registerTool(
    'remove_shortcut',
    {
      description: 'Remove a desktop shortcut by its ID.',
      inputSchema: {
        shortcutId: z.string().describe('The shortcut ID to remove'),
      },
    },
    async (args) => {
      const removed = await removeShortcut(args.shortcutId);
      if (!removed) {
        return error(`Shortcut "${args.shortcutId}" not found.`);
      }
      actionEmitter.emitAction({
        type: 'desktop.removeShortcut',
        shortcutId: args.shortcutId,
      });
      return ok(`Shortcut "${args.shortcutId}" removed.`);
    },
  );

  server.registerTool(
    'update_shortcut',
    {
      description: 'Update a desktop shortcut (label, icon, target, etc.).',
      inputSchema: {
        shortcutId: z.string().describe('The shortcut ID to update'),
        label: z.string().optional().describe('New display name'),
        icon: z.string().optional().describe('New emoji or image path'),
        iconType: z.enum(['emoji', 'image']).optional().describe('New icon type'),
        type: z.enum(['file', 'url', 'action']).optional().describe('New shortcut type'),
        target: z.string().optional().describe('New target path/URL/action'),
      },
    },
    async (args) => {
      const { shortcutId, ...updates } = args;
      // Filter out undefined values
      const filtered = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(filtered).length === 0) {
        return error('No updates provided.');
      }
      const updated = await updateShortcut(shortcutId, filtered);
      if (!updated) {
        return error(`Shortcut "${shortcutId}" not found.`);
      }
      actionEmitter.emitAction({
        type: 'desktop.updateShortcut',
        shortcutId,
        updates: filtered,
      });
      return ok(`Shortcut "${shortcutId}" updated.`);
    },
  );

  server.registerTool(
    'list_shortcuts',
    {
      description: 'List all desktop shortcuts.',
    },
    async () => {
      const shortcuts = await readShortcuts();
      return ok(JSON.stringify(shortcuts, null, 2));
    },
  );
}
