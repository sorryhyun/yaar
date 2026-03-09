/**
 * App development compile tools - compile and typecheck.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stat } from 'fs/promises';
import { ok, error } from '../../utils.js';
import {
  compileTypeScript,
  typecheckSandbox,
  getSandboxPath,
} from '../../../lib/compiler/index.js';
import { parseFileUri } from '@yaar/shared';

// ── Core logic (reusable from verb layer) ──

export async function doCompile(
  sandboxId: string,
  options?: { title?: string },
): Promise<{ success: true; previewUrl: string } | { success: false; error: string }> {
  const sandboxPath = getSandboxPath(sandboxId);
  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }
  const result = await compileTypeScript(sandboxPath, { title: options?.title });
  if (!result.success) {
    return {
      success: false,
      error: `Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`,
    };
  }
  return { success: true, previewUrl: `/api/sandbox/${sandboxId}/dist/index.html` };
}

export async function doTypecheck(
  sandboxId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const sandboxPath = getSandboxPath(sandboxId);
  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }
  const result = await typecheckSandbox(sandboxPath);
  if (result.success) return { success: true };
  return { success: false, error: `Type check found errors:\n${result.diagnostics.join('\n')}` };
}

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
