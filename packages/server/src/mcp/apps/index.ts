/**
 * Apps tools - discover and manage apps in the apps/ directory.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { listApps, loadAppSkill } from './discovery.js';
import { readAppConfig, writeAppConfig } from './config.js';
import { registerBadgeTool } from './badge.js';

export const APPS_TOOL_NAMES = [
  'mcp__apps__list',
  'mcp__apps__load_skill',
  'mcp__apps__read_config',
  'mcp__apps__write_config',
  'mcp__apps__set_app_badge',
] as const;

export function registerAppsTools(server: McpServer): void {
  registerBadgeTool(server);

  // apps_list - List available apps
  server.registerTool(
    'list',
    {
      description:
        'List all available apps in the local directory "apps/". Returns app ID, name, and whether it has SKILL.md and credentials.',
    },
    async () => {
      const apps = await listApps();

      if (apps.length === 0) {
        return ok('No apps found in apps/ directory.');
      }

      const lines = apps.map((app) => {
        const flags = [];
        if (app.hasSkill) flags.push('skill');
        if (app.hasCredentials) flags.push('credentials');
        if (app.appProtocol) flags.push('app-protocol');
        if (app.hidden) flags.push('hidden');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        let line = `- ${app.name} (${app.id})${flagStr}`;
        if (app.description) line += `\n  ${app.description}`;
        if (app.fileAssociations?.length) {
          const assocParts = app.fileAssociations.map(
            (fa) => `${fa.extensions.join(', ')} → ${fa.command}(${fa.paramKey})`,
          );
          line += `\n  Opens: ${assocParts.join('; ')}`;
        }
        return line;
      });

      return ok(`Available apps:\n${lines.join('\n')}`);
    },
  );

  // apps_load_skill - Load SKILL.md for an app
  server.registerTool(
    'load_skill',
    {
      description:
        'Load the SKILL.md file for a specific app. This contains instructions on how to use the app, including API endpoints, authentication, and available actions.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
      },
    },
    async (args) => {
      const skill = await loadAppSkill(args.appId);

      if (skill === null) {
        return error(`No SKILL.md found for app "${args.appId}". Use list to see available apps.`);
      }

      return ok(skill);
    },
  );

  // apps_read_config - Read app config file
  server.registerTool(
    'read_config',
    {
      description:
        'Read a configuration file from an app. For credentials.json, reads from config/credentials/{appId}.json. Other files read from apps/{appId}/. Returns parsed JSON if valid, otherwise returns raw content.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
        filename: z.string().optional().describe('Config filename (default: credentials.json)'),
      },
    },
    async (args) => {
      const result = await readAppConfig(args.appId, args.filename);

      if (!result.success) {
        return error(result.error!);
      }

      // Format content based on type
      if (typeof result.content === 'object') {
        return ok(JSON.stringify(result.content, null, 2));
      }
      return ok(String(result.content));
    },
  );

  // apps_write_config - Write app config file
  server.registerTool(
    'write_config',
    {
      description:
        'Write a configuration file for an app. For credentials.json, writes to config/credentials/{appId}.json. Other files write to apps/{appId}/. Content will be stored as JSON.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
        filename: z.string().describe('Config filename (e.g., credentials.json)'),
        content: z
          .record(z.string(), z.any())
          .describe('Content to write (will be JSON stringified)'),
      },
    },
    async (args) => {
      const result = await writeAppConfig(args.appId, args.filename, args.content);

      if (!result.success) {
        return error(result.error!);
      }

      return ok(`Successfully wrote ${args.filename} for app "${args.appId}".`);
    },
  );
}
