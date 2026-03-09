/**
 * System info and memorize tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../../utils.js';
import { configRead, configWrite } from '../../../storage/storage-manager.js';

export function registerInfoTools(server: McpServer): void {
  // get_info — system info + optional env var reading
  server.registerTool(
    'get_info',
    {
      description:
        'Get system environment info. Optionally read a non-sensitive environment variable.',
      inputSchema: {
        envVar: z
          .string()
          .optional()
          .describe(
            'Environment variable name to read (sensitive vars like keys/tokens are blocked)',
          ),
      },
    },
    async (args) => {
      if (args.envVar) {
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

        const isSensitive = sensitivePatterns.some((pattern) => pattern.test(args.envVar!));

        if (isSensitive) {
          return error(`Cannot read sensitive environment variable "${args.envVar}"`);
        }

        const value = process.env[args.envVar];

        if (value === undefined) {
          return error(`Environment variable "${args.envVar}" is not set`);
        }

        return ok(value);
      }

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
        return error(`Failed to save memory: ${result.error}`);
      }
      return ok(`Memorized: "${args.content}"`);
    },
  );
}
