/**
 * Apps tools - discover and manage apps in the apps/ directory.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { listApps, loadAppSkill } from './discovery.js';
import { registerBadgeTool } from './badge.js';
import { registerMarketTools } from './market.js';

export const APPS_TOOL_NAMES = [
  'mcp__apps__list',
  'mcp__apps__load_skill',
  'mcp__apps__set_app_badge',
  'mcp__apps__market_list',
  'mcp__apps__market_get',
  'mcp__apps__market_delete',
] as const;

export function registerAppsTools(server: McpServer): void {
  registerBadgeTool(server);
  registerMarketTools(server);

  // apps_list - List available apps
  server.registerTool(
    'list',
    {
      description:
        'List all available apps in the local directory "apps/". Returns app ID, name, and whether it has SKILL.md and config.',
    },
    async () => {
      const apps = await listApps();

      if (apps.length === 0) {
        return ok('No apps found in apps/ directory.');
      }

      const lines = apps.map((app) => {
        const flags = [];
        if (app.hasSkill) flags.push('skill');
        if (app.hasConfig) flags.push('config');
        if (app.appProtocol) flags.push('app-protocol');
        if (app.createShortcut === false) flags.push('no-shortcut');
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
        'Load the SKILL.md file for a specific app. This contains instructions on how to use the app, including API endpoints, authentication, and available actions. If an app fails to open (e.g. iframe 404), try loading its skill — some apps are pure-skill with no static files.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
      },
    },
    async (args) => {
      const skill = await loadAppSkill(args.appId);

      if (skill === null) {
        return error(`No SKILL.md found for app "${args.appId}". Use list to see available apps.`);
      }

      // Append static protocol manifest if available in app.json
      const apps = await listApps();
      const app = apps.find((a) => a.id === args.appId);
      if (app?.protocol) {
        const sections: string[] = [];
        const { state, commands } = app.protocol;
        if (state && Object.keys(state).length) {
          sections.push(
            '### State\n' +
              Object.entries(state)
                .map(([k, v]) => `- \`${k}\` — ${v.description}`)
                .join('\n'),
          );
        }
        if (commands && Object.keys(commands).length) {
          sections.push(
            '### Commands\n' +
              Object.entries(commands)
                .map(([k, v]) => {
                  let line = `- \`${k}\` — ${v.description}`;
                  if (v.params) line += `\n  Params: \`${JSON.stringify(v.params)}\``;
                  return line;
                })
                .join('\n'),
          );
        }
        if (sections.length) {
          return ok(skill + '\n\n## Protocol\n\n' + sections.join('\n\n'));
        }
      }

      return ok(skill);
    },
  );
}
