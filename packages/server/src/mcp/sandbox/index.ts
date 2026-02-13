/**
 * Sandbox tools - execute JavaScript code in a sandboxed environment.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { executeJs } from '../../lib/sandbox/index.js';
import { readAllowedDomains } from '../domains.js';

const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

/**
 * Format execution result for MCP response.
 */
function formatResult(result: Awaited<ReturnType<typeof executeJs>>): string {
  const parts: string[] = [];

  // Console output
  if (result.logsFormatted) {
    parts.push('Console output:');
    parts.push(result.logsFormatted);
    parts.push('');
  }

  // Result or error
  if (result.success) {
    if (result.result !== undefined) {
      parts.push(`Result: ${result.result}`);
    } else {
      parts.push('Result: undefined');
    }
  } else {
    parts.push(`Error: ${result.error}`);
  }

  // Execution time
  parts.push(`Execution time: ${Math.round(result.executionTimeMs)}ms`);

  return parts.join('\n');
}

export function registerSandboxTools(server: McpServer): void {
  // run_js
  server.registerTool(
    'run_js',
    {
      description:
        'Execute JavaScript code in a sandboxed environment and return the result. Code runs in an async IIFE (await supported). Use guideline("sandbox") for available globals and restrictions.',
      inputSchema: {
        code: z.string().describe('JavaScript code to execute'),
        timeout: z
          .number()
          .min(100)
          .max(MAX_TIMEOUT)
          .optional()
          .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT})`),
      },
    },
    async (args) => {
      const allowedDomains = await readAllowedDomains();
      const result = await executeJs(args.code, { timeout: args.timeout, allowedDomains });
      return ok(formatResult(result));
    },
  );
}
