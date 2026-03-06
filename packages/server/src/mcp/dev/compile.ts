/**
 * App development compile tools - compile and typecheck.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stat } from 'fs/promises';
import { ok, error } from '../utils.js';
import { compileTypeScript, typecheckSandbox, getSandboxPath } from '../../lib/compiler/index.js';
import { parseFileUri } from '@yaar/shared';

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
      const { title } = args;

      const parsed = parseFileUri(args.uri);
      if (!parsed || parsed.authority !== 'sandbox' || !parsed.sandboxId) {
        return error('Expected a sandbox URI (e.g. yaar://sandbox/123).');
      }
      const sandboxId = parsed.sandboxId;
      const sandboxPath = getSandboxPath(sandboxId);

      // Check sandbox exists
      try {
        await stat(sandboxPath);
      } catch {
        return error(`Sandbox "${sandboxId}" not found.`);
      }

      // Compile
      const result = await compileTypeScript(sandboxPath, { title });

      if (!result.success) {
        return error(`Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`);
      }

      const previewUrl = `/api/sandbox/${sandboxId}/dist/index.html`;

      return ok(
        JSON.stringify(
          {
            success: true,
            previewUrl,
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
      const sandboxId = parsed.sandboxId;
      const sandboxPath = getSandboxPath(sandboxId);

      try {
        await stat(sandboxPath);
      } catch {
        return error(`Sandbox "${sandboxId}" not found.`);
      }

      const result = await typecheckSandbox(sandboxPath);

      if (result.success) {
        return ok('Type check passed — no errors found.');
      }

      return error(`Type check found errors:\n${result.diagnostics.join('\n')}`);
    },
  );
}
