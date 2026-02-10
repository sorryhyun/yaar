/**
 * System tools - system info, environment, memorize.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { configRead, configWrite } from '../../storage/storage-manager.js';

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
    }
  );

  // get_env_var
  server.registerTool(
    'get_env_var',
    {
      description: 'Get the value of a safe environment variable. Only allows reading non-sensitive variables.',
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
    }
  );

  // memorize
  server.registerTool(
    'memorize',
    {
      description:
        'Save a sentence or note to persistent memory. These notes are automatically included in your system prompt across sessions.',
      inputSchema: {
        content: z
          .string()
          .describe('A sentence or note to remember across sessions'),
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
    }
  );
}
