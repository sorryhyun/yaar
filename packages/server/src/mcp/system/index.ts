/**
 * System tools - system info, environment, memorize.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { configRead, configWrite } from '../../storage/storage-manager.js';
import { actionEmitter } from '../action-emitter.js';
import { addHook, loadHooks, removeHook } from './hooks.js';

export function registerSystemTools(server: McpServer): void {
  // get_system_info
  server.registerTool(
    'get_info',
    {
      description: 'Get information about the YAAR system environment',
    },
    async () => {
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
  );

  // get_env_var
  server.registerTool(
    'get_env_var',
    {
      description:
        'Get the value of a safe environment variable. Only allows reading non-sensitive variables.',
      inputSchema: {
        name: z.string().describe('Name of the environment variable to read'),
      },
    },
    async (args) => {
      const sensitivePatterns = [
        /key/i,
        /secret/i,
        /password/i,
        /token/i,
        /auth/i,
        /credential/i,
        /private/i,
        /api/i,
      ];

      const isSensitive = sensitivePatterns.some((pattern) => pattern.test(args.name));

      if (isSensitive) {
        return ok(`Error: Cannot read sensitive environment variable "${args.name}"`);
      }

      const value = process.env[args.name];

      if (value === undefined) {
        return ok(`Environment variable "${args.name}" is not set`);
      }

      return ok(value);
    },
  );

  // memorize
  server.registerTool(
    'memorize',
    {
      description:
        'Save a sentence or note to persistent memory. These notes are automatically included in your system prompt across sessions.',
      inputSchema: {
        content: z.string().describe('A sentence or note to remember across sessions'),
      },
    },
    async (args) => {
      const existing = await configRead('memory.md');
      const current = existing.success ? (existing.content ?? '') : '';
      const updated = current ? current.trimEnd() + '\n' + args.content : args.content;
      const result = await configWrite('memory.md', updated + '\n');
      if (!result.success) {
        return ok(`Error saving memory: ${result.error}`);
      }
      return ok(`Memorized: "${args.content}"`);
    },
  );

  // set_config — register a hook
  server.registerTool(
    'set_config',
    {
      description:
        'Register an automated hook that fires on a desktop event. Supports "launch" (session start) and "tool_use" (when the AI calls a tool) events.',
      inputSchema: {
        event: z.enum(['launch', 'tool_use']).describe('The event that triggers this hook'),
        filter: z
          .object({
            toolName: z
              .union([z.string(), z.array(z.string())])
              .describe('Tool name(s) to match (e.g., "apps:clone")'),
          })
          .optional()
          .describe('Filter for tool_use hooks — which tools trigger this hook'),
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
          .describe('What happens when the hook fires'),
        label: z.string().describe('Human-readable description shown in permission dialog'),
      },
    },
    async (args) => {
      const approved = await actionEmitter.showPermissionDialog(
        'Add Hook',
        `The AI wants to add a hook: **${args.label}** (${args.event}). Allow?`,
        'config_hook',
        args.event,
      );

      if (!approved) {
        return ok('Permission denied — hook was not added.');
      }

      const hook = await addHook(args.event, args.action as any, args.label, args.filter);
      return ok(`Hook registered: "${hook.label}" (${hook.id})`);
    },
  );

  // get_config — read hooks
  server.registerTool(
    'get_config',
    {
      description: 'Read current configuration. Returns registered hooks.',
      inputSchema: {
        section: z.enum(['hooks']).optional().describe('Config section to read (default: all)'),
      },
    },
    async () => {
      const hooks = await loadHooks();
      return ok(JSON.stringify({ hooks }, null, 2));
    },
  );

  // remove_config — delete a hook
  server.registerTool(
    'remove_config',
    {
      description: 'Remove a registered hook by its ID.',
      inputSchema: {
        hookId: z.string().describe('The hook ID to remove (e.g., "hook-1")'),
      },
    },
    async (args) => {
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
        return ok(`Hook "${args.hookId}" not found.`);
      }
      return ok(`Hook "${args.hookId}" removed.`);
    },
  );
}
