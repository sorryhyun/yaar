/**
 * Sandbox tools - execute JavaScript/TypeScript code in a sandboxed environment.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { executeJs, executeTs } from '../../lib/sandbox/index.js';

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
      description: `Execute JavaScript code in a sandboxed environment and return the result.

The code runs in an isolated vm context with limited globals:
- console (log, info, warn, error, debug) - output is captured and returned
- JSON, Math, Date
- Object, Array, String, Number, Boolean, Map, Set, etc.
- RegExp, Error types
- URL, URLSearchParams (parsing only, no network)
- TextEncoder, TextDecoder, atob, btoa
- parseInt, parseFloat, isNaN, isFinite

NOT available (for security):
- process, require, import (no Node.js access)
- fetch, XMLHttpRequest (no network)
- setTimeout, setInterval (could escape timeout)
- eval, Function (no dynamic code generation)
- fs, child_process, os (no system access)

Use \`return\` to return a value from the code.`,
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
      const result = await executeJs(args.code, { timeout: args.timeout });
      return ok(formatResult(result));
    }
  );

  // run_ts
  server.registerTool(
    'run_ts',
    {
      description: `Execute TypeScript code in a sandboxed environment and return the result.

The code is compiled to JavaScript using esbuild before execution.
Same sandboxed environment as run_js with limited globals.

Available globals:
- console (log, info, warn, error, debug) - output is captured and returned
- JSON, Math, Date
- Object, Array, String, Number, Boolean, Map, Set, etc.
- RegExp, Error types
- URL, URLSearchParams (parsing only, no network)
- TextEncoder, TextDecoder, atob, btoa
- parseInt, parseFloat, isNaN, isFinite

NOT available (for security):
- process, require, import (no Node.js access)
- fetch, XMLHttpRequest (no network)
- setTimeout, setInterval (could escape timeout)
- eval, Function (no dynamic code generation)
- fs, child_process, os (no system access)

Use \`return\` to return a value from the code.`,
      inputSchema: {
        code: z.string().describe('TypeScript code to execute'),
        timeout: z
          .number()
          .min(100)
          .max(MAX_TIMEOUT)
          .optional()
          .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT})`),
      },
    },
    async (args) => {
      const result = await executeTs(args.code, { timeout: args.timeout });
      return ok(formatResult(result));
    }
  );
}
