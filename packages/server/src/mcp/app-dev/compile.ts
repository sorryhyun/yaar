/**
 * App development compile tools - compile and compile_component.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { ok } from '../utils.js';
import { compileTypeScript, typecheckSandbox, getSandboxPath } from '../../lib/compiler/index.js';
import { componentLayoutSchema } from '@yaar/shared';

export function registerCompileTools(server: McpServer): void {
  // compile - Compile sandbox TypeScript to HTML
  server.registerTool(
    'compile',
    {
      description:
        'Compile TypeScript from a sandbox to a bundled HTML file. Entry point is src/main.ts. Returns a preview URL for viewing the app.',
      inputSchema: {
        sandbox: z.string().describe('Sandbox ID to compile'),
        entry: z.string().optional().describe('Entry file (default: src/main.ts) - not yet supported'),
        title: z.string().optional().describe('App title for HTML page (default: "App")'),
      },
    },
    async (args) => {
      const { sandbox: sandboxId, title } = args;

      // Validate sandbox ID (must be numeric timestamp)
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      // Check sandbox exists
      try {
        await stat(sandboxPath);
      } catch {
        return ok(`Error: Sandbox "${sandboxId}" not found.`);
      }

      // Compile
      const result = await compileTypeScript(sandboxPath, { title });

      if (!result.success) {
        return ok(`Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`);
      }

      const previewUrl = `/api/sandbox/${sandboxId}/dist/index.html`;

      return ok(JSON.stringify({
        success: true,
        previewUrl,
        message: 'Compilation successful. Use create with renderer: "iframe" to preview.',
      }, null, 2));
    }
  );

  // compile_component - Write a .yaarcomponent.json file to sandbox
  server.registerTool(
    'compile_component',
    {
      description:
        'Create a .yaarcomponent.json file in a sandbox. This lets you define reusable component window layouts that get deployed alongside the app. After deploy, the AI can load them via create_component(jsonfile="{appId}/{filename}").',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID to write the component file into'),
        filename: z.string().describe('Filename (e.g., "dashboard.yaarcomponent.json"). Must end with .yaarcomponent.json.'),
        components: z.array(z.record(z.string(), z.unknown())).describe('Flat array of UI components (same format as create_component)'),
        cols: z.union([z.array(z.number()), z.number()]).optional().describe('Column layout'),
        gap: z.enum(['none', 'sm', 'md', 'lg']).optional().describe('Spacing between components'),
      },
    },
    async (args) => {
      const { sandboxId, filename } = args;

      if (!filename.endsWith('.yaarcomponent.json')) {
        return ok('Error: Filename must end with .yaarcomponent.json');
      }
      if (filename.includes('/') || filename.includes('..')) {
        return ok('Error: Filename must not contain path separators.');
      }
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const layout = {
        components: args.components,
        ...(args.cols !== undefined && { cols: args.cols }),
        ...(args.gap !== undefined && { gap: args.gap }),
      };

      // Validate against component layout schema
      const result = componentLayoutSchema.safeParse(layout);
      if (!result.success) {
        return ok(`Error: Invalid component layout: ${result.error.message}`);
      }

      const sandboxPath = getSandboxPath(sandboxId);
      const fullPath = join(sandboxPath, filename);

      try {
        await mkdir(sandboxPath, { recursive: true });
        await writeFile(fullPath, JSON.stringify(result.data, null, 2), 'utf-8');

        return ok(JSON.stringify({
          sandboxId,
          filename,
          message: `Component file written to sandbox/${sandboxId}/${filename}. It will be deployed alongside the app.`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error: ${error}`);
      }
    }
  );

  // typecheck - Run TypeScript type checking on sandbox code
  server.registerTool(
    'typecheck',
    {
      description:
        'Run TypeScript type checking on sandbox code (loose mode, no emit). Returns diagnostics if there are type errors.',
      inputSchema: {
        sandbox: z.string().describe('Sandbox ID to type-check'),
      },
    },
    async (args) => {
      const { sandbox: sandboxId } = args;

      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      try {
        await stat(sandboxPath);
      } catch {
        return ok(`Error: Sandbox "${sandboxId}" not found.`);
      }

      const result = await typecheckSandbox(sandboxPath);

      if (result.success) {
        return ok('Type check passed — no errors found.');
      }

      return ok(`Type check found errors:\n${result.diagnostics.join('\n')}`);
    }
  );
}
