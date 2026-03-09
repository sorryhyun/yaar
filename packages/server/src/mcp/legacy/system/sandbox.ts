/**
 * Sandbox tools - execute JavaScript code in a sandboxed environment.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../../utils.js';
import { executeJs } from '../../../lib/sandbox/index.js';
import { readAllowedDomains, isAllDomainsAllowed } from '../../domains.js';

const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

/** Common sandbox-escape patterns → short hint */
const SANDBOX_HINTS: [RegExp, string][] = [
  [
    /\brequire\b/,
    'require() is not available. This sandbox uses ESM — only built-in globals and fetch (for allowed domains) are provided.',
  ],
  [/\bDeno\b/, 'Deno APIs are not available. This is a Node.js vm sandbox, not Deno.'],
  [
    /\b(readFile|writeFile|readdir)\b/,
    'Node.js fs APIs are not available in the sandbox. Use storage tools for file access.',
  ],
  [/\bprocess\b/, 'process is not available. The sandbox has no access to the host environment.'],
  [/\bimport\s*\(/, 'Dynamic import() is not available in the sandbox.'],
];

/**
 * Format execution result for MCP response.
 */
function formatResult(result: Awaited<ReturnType<typeof executeJs>>, code: string): string {
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

    // Add a hint if the error looks like a sandbox-escape attempt
    if (result.error?.includes('is not defined') || result.error?.includes('is not a function')) {
      for (const [pattern, hint] of SANDBOX_HINTS) {
        if (pattern.test(code)) {
          parts.push(`Hint: ${hint}`);
          break;
        }
      }
    }
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
        'Execute JavaScript code in a sandboxed environment and return the result. Code runs in an async IIFE (await supported).',
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
      const [allowedDomains, allowAllDomains] = await Promise.all([
        readAllowedDomains(),
        isAllDomainsAllowed(),
      ]);
      const result = await executeJs(args.code, {
        timeout: args.timeout,
        allowedDomains,
        allowAllDomains,
      });
      return ok(formatResult(result, args.code));
    },
  );
}
