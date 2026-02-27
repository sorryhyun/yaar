/**
 * Config tools — set_config, get_config, remove_config.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { readSettings, updateSettings, LANGUAGE_CODES } from '../../storage/settings.js';
import { actionEmitter } from '../action-emitter.js';
import { addHook, loadHooks, removeHook } from './hooks.js';
import {
  readShortcuts,
  addShortcut,
  removeShortcut,
  updateShortcut,
} from '../../storage/shortcuts.js';
import type { DesktopShortcut } from '@yaar/shared';

export function registerConfigTools(server: McpServer): void {
  // set_config — unified config setter for hooks, settings, and shortcuts
  server.registerTool(
    'set_config',
    {
      description:
        'Update configuration. Use section "hooks" to register automated hooks, "settings" to update user settings, or "shortcuts" to create/update desktop shortcuts.',
      inputSchema: {
        section: z.enum(['hooks', 'settings', 'shortcuts']).describe('Config section to update'),
        // Hook fields (required when section is "hooks")
        event: z
          .enum(['launch', 'tool_use'])
          .optional()
          .describe('(hooks) The event that triggers this hook'),
        filter: z
          .object({
            toolName: z
              .union([z.string(), z.array(z.string())])
              .describe('Tool name(s) to match (e.g., "apps:clone")'),
          })
          .optional()
          .describe('(hooks) Filter for tool_use hooks — which tools trigger this hook'),
        action: z
          .object({
            type: z
              .enum(['interaction', 'os_action'])
              .describe(
                'Action type: "interaction" injects a user message, "os_action" emits OS Actions',
              ),
            payload: z
              .union([
                z.string(),
                z.record(z.string(), z.unknown()),
                z.array(z.record(z.string(), z.unknown())),
              ])
              .describe('String for interaction, object or array for os_action'),
          })
          .optional()
          .describe('(hooks) What happens when the hook fires'),
        label: z
          .string()
          .optional()
          .describe('(hooks/shortcuts) Human-readable description shown in permission dialog'),
        // Settings fields (used when section is "settings")
        language: z
          .enum(LANGUAGE_CODES as unknown as [string, ...string[]])
          .optional()
          .describe('(settings) Language code (e.g., "en", "ko", "ja")'),
        onboardingCompleted: z
          .boolean()
          .optional()
          .describe('(settings) Mark onboarding as completed'),
        // Shortcut fields (used when section is "shortcuts")
        shortcutId: z
          .string()
          .optional()
          .describe(
            '(shortcuts) Shortcut ID — if provided, updates existing; if absent, creates new',
          ),
        icon: z.string().optional().describe('(shortcuts) Emoji icon or storage image path'),
        iconType: z
          .enum(['emoji', 'image'])
          .optional()
          .describe('(shortcuts) Icon type (default: emoji)'),
        shortcutType: z
          .enum(['file', 'url', 'action', 'app', 'skill'])
          .optional()
          .describe('(shortcuts) Shortcut type'),
        target: z
          .string()
          .optional()
          .describe('(shortcuts) Storage path (file), URL (url), or action identifier (action)'),
        osActions: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            '(shortcuts) OS Actions to execute client-side on click (bypasses AI). Each object needs a "type" field.',
          ),
        skill: z
          .string()
          .optional()
          .describe(
            '(shortcuts) Skill/macro instructions — sent to AI when the shortcut is clicked (type "skill")',
          ),
      },
    },
    async (args) => {
      if (args.section === 'settings') {
        const partial: Record<string, unknown> = {};
        if (args.language !== undefined) partial.language = args.language;
        if (args.onboardingCompleted !== undefined)
          partial.onboardingCompleted = args.onboardingCompleted;
        const settings = await updateSettings(partial as any);
        actionEmitter.emitAction({ type: 'desktop.refreshApps' });
        return ok(JSON.stringify(settings, null, 2));
      }

      if (args.section === 'shortcuts') {
        if (args.shortcutId) {
          // Update existing shortcut
          const updates: Record<string, unknown> = {};
          if (args.label !== undefined) updates.label = args.label;
          if (args.icon !== undefined) updates.icon = args.icon;
          if (args.iconType !== undefined) updates.iconType = args.iconType;
          if (args.shortcutType !== undefined) updates.type = args.shortcutType;
          if (args.target !== undefined) updates.target = args.target;
          if (args.osActions !== undefined) updates.osActions = args.osActions;
          if (args.skill !== undefined) updates.skill = args.skill;
          if (Object.keys(updates).length === 0) {
            return error('No updates provided.');
          }
          const updated = await updateShortcut(args.shortcutId, updates);
          if (!updated) {
            return error(`Shortcut "${args.shortcutId}" not found.`);
          }
          actionEmitter.emitAction({
            type: 'desktop.updateShortcut',
            shortcutId: args.shortcutId,
            updates,
          });
          return ok(`Shortcut "${args.shortcutId}" updated.`);
        }

        // Create new shortcut
        if (args.shortcutType === 'skill') {
          if (!args.label || !args.icon || !args.skill) {
            return error('skill shortcuts require label, icon, and skill fields.');
          }
        } else if (!args.label || !args.icon || !args.shortcutType || !args.target) {
          return error(
            'shortcuts section requires label, icon, shortcutType, and target fields to create.',
          );
        }
        const shortcut: DesktopShortcut = {
          id: `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: args.label!,
          icon: args.icon!,
          iconType: args.iconType,
          type: args.shortcutType!,
          target: args.target || '',
          osActions: args.osActions as DesktopShortcut['osActions'],
          ...(args.skill && { skill: args.skill }),
          createdAt: Date.now(),
        };
        await addShortcut(shortcut);
        actionEmitter.emitAction({ type: 'desktop.createShortcut', shortcut });
        return ok(`Shortcut created: "${shortcut.label}" (${shortcut.id})`);
      }

      // section === 'hooks'
      if (!args.event || !args.action || !args.label) {
        return error('hooks section requires event, action, and label fields.');
      }

      const approved = await actionEmitter.showPermissionDialog(
        'Add Hook',
        `The AI wants to add a hook: **${args.label}** (${args.event}). Allow?`,
        'config_hook',
        args.event,
      );

      if (!approved) {
        return error('Permission denied — hook was not added.');
      }

      const hook = await addHook(args.event, args.action as any, args.label, args.filter);
      return ok(`Hook registered: "${hook.label}" (${hook.id})`);
    },
  );

  // get_config — read hooks, settings, and/or shortcuts
  server.registerTool(
    'get_config',
    {
      description: 'Read current configuration. Returns hooks, settings, shortcuts, or all.',
      inputSchema: {
        section: z
          .enum(['hooks', 'settings', 'shortcuts'])
          .optional()
          .describe('Config section to read (default: all)'),
      },
    },
    async (args) => {
      if (args.section === 'hooks') {
        const hooks = await loadHooks();
        return ok(JSON.stringify({ hooks }, null, 2));
      }
      if (args.section === 'settings') {
        const settings = await readSettings();
        return ok(JSON.stringify({ settings }, null, 2));
      }
      if (args.section === 'shortcuts') {
        const shortcuts = await readShortcuts();
        return ok(JSON.stringify({ shortcuts }, null, 2));
      }
      const [hooks, settings, shortcuts] = await Promise.all([
        loadHooks(),
        readSettings(),
        readShortcuts(),
      ]);
      return ok(JSON.stringify({ hooks, settings, shortcuts }, null, 2));
    },
  );

  // remove_config — delete a hook or shortcut
  server.registerTool(
    'remove_config',
    {
      description: 'Remove a registered hook or desktop shortcut by its ID.',
      inputSchema: {
        hookId: z.string().optional().describe('The hook ID to remove (e.g., "hook-1")'),
        shortcutId: z.string().optional().describe('The shortcut ID to remove'),
      },
    },
    async (args) => {
      if (args.shortcutId) {
        const removed = await removeShortcut(args.shortcutId);
        if (!removed) {
          return error(`Shortcut "${args.shortcutId}" not found.`);
        }
        actionEmitter.emitAction({
          type: 'desktop.removeShortcut',
          shortcutId: args.shortcutId,
        });
        return ok(`Shortcut "${args.shortcutId}" removed.`);
      }

      if (!args.hookId) {
        return error('Provide either hookId or shortcutId.');
      }

      const confirmed = await actionEmitter.showConfirmDialog(
        'Remove Hook',
        `Remove hook "${args.hookId}"?`,
        'Remove',
        'Cancel',
      );

      if (!confirmed) {
        return ok('Cancelled — hook was not removed.');
      }

      const removed = await removeHook(args.hookId);
      if (!removed) {
        return error(`Hook "${args.hookId}" not found.`);
      }
      return ok(`Hook "${args.hookId}" removed.`);
    },
  );
}
