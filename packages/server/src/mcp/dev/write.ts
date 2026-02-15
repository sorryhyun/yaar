/**
 * App development write tools - write_ts and apply_diff_ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { ok, error } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { isValidPath, generateSandboxId } from './helpers.js';

export function registerWriteTools(server: McpServer): void {
  // app_write_ts - Write TypeScript to sandbox
  server.registerTool(
    'write_ts',
    {
      description:
        'Write TypeScript code to a sandbox directory. Creates a new sandbox if sandboxId is not provided. Use guideline("app_dev") for available bundled libraries and storage API.',
      inputSchema: {
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        content: z.string().describe('TypeScript source code'),
        sandboxId: z
          .string()
          .optional()
          .describe('Sandbox ID. If omitted, creates a new sandbox with timestamp ID.'),
      },
    },
    async (args) => {
      const { path, content, sandboxId: providedId } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return error('Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID if provided (must be numeric timestamp)
      if (providedId && !/^\d+$/.test(providedId)) {
        return error(
          'Invalid sandbox ID. Must be a numeric timestamp (from clone or a previous write_ts call). Do not use app names as sandbox IDs.',
        );
      }

      // Create or use existing sandbox
      const sandboxId = providedId ?? generateSandboxId();
      const sandboxPath = getSandboxPath(sandboxId);

      // Validate the full path is within sandbox
      if (!isValidPath(sandboxPath, path)) {
        return error('Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      try {
        // Ensure parent directory exists
        await mkdir(dirname(fullPath), { recursive: true });

        // Write the file
        await writeFile(fullPath, content, 'utf-8');

        return ok(
          JSON.stringify(
            {
              sandboxId,
              path,
              message: `File written to sandbox/${sandboxId}/${path}`,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return error(msg);
      }
    },
  );

  // apply_diff_ts - Apply search-and-replace edit to a sandbox file
  server.registerTool(
    'apply_diff_ts',
    {
      description:
        'Apply a search-and-replace edit to an existing file in a sandbox. Finds the exact old_string and replaces it with new_string. Use this to revise code without rewriting the entire file.',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID containing the file'),
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        old_string: z.string().describe('The exact text to find (must be unique in the file)'),
        new_string: z.string().describe('The replacement text'),
      },
    },
    async (args) => {
      const { sandboxId, path, old_string, new_string } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return error('Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return error('Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      if (!isValidPath(sandboxPath, path)) {
        return error('Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      // Read existing content
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        return error(`File not found: ${path}`);
      }

      // Check old_string exists
      if (!content.includes(old_string)) {
        return error(
          'old_string not found in file. Make sure it matches exactly (including whitespace).',
        );
      }

      // Check uniqueness
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        return error(
          `old_string found ${count} times. Provide more surrounding context to make it unique.`,
        );
      }

      // Apply replacement
      const newContent = content.replace(old_string, new_string);
      await writeFile(fullPath, newContent, 'utf-8');

      return ok(
        JSON.stringify(
          {
            sandboxId,
            path,
            message: `Applied edit to sandbox/${sandboxId}/${path}`,
          },
          null,
          2,
        ),
      );
    },
  );
}
