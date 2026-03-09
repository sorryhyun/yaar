/**
 * Config tools — set, get, remove.
 *
 * Each section (hooks, settings, shortcuts, mounts, app) is defined in its own
 * file. This module composes them into unified MCP tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../../utils.js';
import { handleSetHook, handleGetHooks, handleRemoveHook } from '../../domains/config/hooks-handler.js';
import { handleSetSettings, handleGetSettings } from '../../domains/config/settings.js';
import { handleSetShortcut, handleGetShortcuts, handleRemoveShortcut } from '../../domains/config/shortcuts.js';
import { handleSetMount, handleGetMounts, handleRemoveMount } from '../../domains/config/mounts.js';
import { handleSetApp, handleGetApp, handleRemoveApp } from '../../domains/config/app.js';

const CONFIG_SECTIONS = ['hooks', 'settings', 'shortcuts', 'mounts', 'app'] as const;
const REMOVABLE_SECTIONS = ['hooks', 'shortcuts', 'mounts', 'app'] as const;

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'set',
    {
      description:
        'Update configuration. Load skill(topic: "config") for content schema reference.',
      inputSchema: {
        section: z.enum(CONFIG_SECTIONS).describe('Config section to update'),
        content: z
          .record(z.string(), z.unknown())
          .describe('Section-specific content object — see skill(topic: "config") for schema'),
      },
    },
    async (args) => {
      switch (args.section) {
        case 'settings':
          return handleSetSettings(args.content);
        case 'shortcuts':
          return handleSetShortcut(args.content);
        case 'mounts':
          return handleSetMount(args.content);
        case 'hooks':
          return handleSetHook(args.content);
        case 'app':
          return handleSetApp(args.content);
      }
    },
  );

  server.registerTool(
    'get',
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
    'remove',
    {
      description: 'Remove a config entry. Load skill(topic: "config") for details.',
      inputSchema: {
        section: z.enum(REMOVABLE_SECTIONS).describe('Config section'),
        id: z.string().describe('Entry ID (hook ID, shortcut ID, mount alias, or app ID)'),
        key: z
          .string()
          .optional()
          .describe('(app only) Remove a single key instead of entire config'),
      },
    },
    async (args) => {
      switch (args.section) {
        case 'hooks':
          return handleRemoveHook(args.id);
        case 'shortcuts':
          return handleRemoveShortcut(args.id);
        case 'mounts':
          return handleRemoveMount(args.id);
        case 'app':
          return handleRemoveApp(args.id, args.key);
      }
    },
  );
}
