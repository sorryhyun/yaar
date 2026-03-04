/**
 * Config tools — set_config, get_config, remove_config.
 *
 * Each section (hooks, settings, shortcuts, mounts, app) is defined in its own
 * config-*.ts file. This module composes them into unified MCP tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import {
  hookSetFields,
  hookRemoveFields,
  handleSetHook,
  handleGetHooks,
  handleRemoveHook,
} from './config-hooks.js';
import { settingsSetFields, handleSetSettings, handleGetSettings } from './config-settings.js';
import {
  shortcutSetFields,
  shortcutRemoveFields,
  handleSetShortcut,
  handleGetShortcuts,
  handleRemoveShortcut,
} from './config-shortcuts.js';
import {
  mountSetFields,
  mountRemoveFields,
  handleSetMount,
  handleGetMounts,
  handleRemoveMount,
} from './config-mounts.js';
import {
  appSetFields,
  appRemoveFields,
  handleSetApp,
  handleGetApp,
  handleRemoveApp,
} from './config-app.js';

const CONFIG_SECTIONS = ['hooks', 'settings', 'shortcuts', 'mounts', 'app'] as const;

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'set_config',
    {
      description:
        'Update configuration. Use section "hooks" for automated hooks, "settings" for user settings, "shortcuts" for desktop shortcuts, "mounts" for host directories, or "app" for per-app config (credentials, preferences).',
      inputSchema: {
        section: z.enum(CONFIG_SECTIONS).describe('Config section to update'),
        label: z
          .string()
          .optional()
          .describe('(hooks/shortcuts) Human-readable description shown in permission dialog'),
        ...hookSetFields,
        ...settingsSetFields,
        ...shortcutSetFields,
        ...mountSetFields,
        ...appSetFields,
      },
    },
    async (args) => {
      switch (args.section) {
        case 'settings':
          return handleSetSettings(args);
        case 'shortcuts':
          return handleSetShortcut(args);
        case 'mounts':
          return handleSetMount(args);
        case 'hooks':
          return handleSetHook(args);
        case 'app':
          return handleSetApp(args);
      }
    },
  );

  server.registerTool(
    'get_config',
    {
      description:
        'Read current configuration. Returns hooks, settings, shortcuts, mounts, app, or all. For "app" section, optionally provide appId to read a specific app\'s config.',
      inputSchema: {
        section: z
          .enum(CONFIG_SECTIONS)
          .optional()
          .describe('Config section to read (default: all)'),
        appId: z.string().optional().describe('(app) Specific app ID to read config for'),
      },
    },
    async (args) => {
      if (args.section) {
        switch (args.section) {
          case 'hooks':
            return ok(JSON.stringify(await handleGetHooks(), null, 2));
          case 'settings':
            return ok(JSON.stringify(await handleGetSettings(), null, 2));
          case 'shortcuts':
            return ok(JSON.stringify(await handleGetShortcuts(), null, 2));
          case 'mounts':
            return ok(JSON.stringify(await handleGetMounts(), null, 2));
          case 'app':
            return ok(JSON.stringify(await handleGetApp(args.appId), null, 2));
        }
      }
      const [hooks, settings, shortcuts, mounts] = await Promise.all([
        handleGetHooks(),
        handleGetSettings(),
        handleGetShortcuts(),
        handleGetMounts(),
      ]);
      return ok(JSON.stringify({ ...hooks, ...settings, ...shortcuts, ...mounts }, null, 2));
    },
  );

  server.registerTool(
    'remove_config',
    {
      description: 'Remove a registered hook, desktop shortcut, mount, or app config by its ID.',
      inputSchema: {
        ...hookRemoveFields,
        ...shortcutRemoveFields,
        ...mountRemoveFields,
        ...appRemoveFields,
      },
    },
    async (args) => {
      if (args.appId) return handleRemoveApp(args.appId, args.appConfigKey);
      if (args.mountAlias) return handleRemoveMount(args.mountAlias);
      if (args.shortcutId) return handleRemoveShortcut(args.shortcutId);
      if (args.hookId) return handleRemoveHook(args.hookId);
      return error('Provide hookId, shortcutId, mountAlias, or appId.');
    },
  );
}
