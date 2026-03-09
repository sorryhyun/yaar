/**
 * App development compile tools - compile and typecheck.
 * @deprecated Legacy MCP tool registration. Domain logic in domains/dev/compile.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../../utils.js';
import { doCompile, doTypecheck } from '../../../features/dev/compile.js';
import { parseFileUri } from '@yaar/shared';

export { doCompile, doTypecheck };

// ── MCP tool registration ──

export function registerCompileTools(server: McpServer): void {
  // compile - Compile sandbox TypeScript to HTML
  server.registerTool(
    'compile',
    {
      description:
        'Compile TypeScript from a sandbox to a bundled HTML file. Entry point is src/main.ts. Returns a preview URL for viewing the app.',
      inputSchema: {
        uri: z.string(),
        entry: z
          .string()
          .optional()
          .describe('Entry file (default: src/main.ts) - not yet supported'),
        title: z.string().optional().describe('App title for HTML page (default: "App")'),
      },
    },
    async (args) => {
      const parsed = parseFileUri(args.uri);
      if (!parsed || parsed.authority !== 'sandbox' || !parsed.sandboxId) {
        return error('Expected a sandbox URI (e.g. yaar://sandbox/123).');
      }
      const result = await doCompile(parsed.sandboxId, { title: args.title });
      if (!result.success) return error(result.error);
      return ok(
        JSON.stringify(
          {
            success: true,
            previewUrl: result.previewUrl,
            message: 'Compilation successful. Use create with renderer: "iframe" to preview.',
          },
          null,
          2,
        ),
      );
    },
  );

  // typecheck - Run TypeScript type checking on sandbox code
  server.registerTool(
    'typecheck',
    {
      description:
        'Run TypeScript type checking on sandbox code (loose mode, no emit). Returns diagnostics if there are type errors.',
      inputSchema: {
        uri: z.string(),
      },
    },
    async (args) => {
      const parsed = parseFileUri(args.uri);
      if (!parsed || parsed.authority !== 'sandbox' || !parsed.sandboxId) {
        return error('Expected a sandbox URI (e.g. yaar://sandbox/123).');
      }
      const result = await doTypecheck(parsed.sandboxId);
      if (!result.success) return error(result.error);
      return ok('Type check passed — no errors found.');
    },
  );
}
