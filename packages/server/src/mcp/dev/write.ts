/**
 * App development write tools - write_ts and apply_diff_ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdir } from 'fs/promises';
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
        'Write TypeScript code to a sandbox directory. Creates a new sandbox if sandboxId is not provided.',
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
        await Bun.write(fullPath, content);

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
        'Apply an edit to an existing file in a sandbox. Two modes:\n' +
        '1. String mode: provide old_string + new_string (finds exact match and replaces)\n' +
        '2. Line mode: provide start_line + new_string (replaces lines start_line..end_line with new_string)\n' +
        'Line numbers are 1-based, matching the output of read_ts.',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID containing the file'),
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        old_string: z
          .string()
          .optional()
          .describe('The exact text to find (must be unique). Omit to use line mode.'),
        new_string: z.string().describe('The replacement text'),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to replace (1-based). Requires line mode (omit old_string).'),
        end_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Last line to replace (1-based, inclusive). Defaults to start_line (single line).',
          ),
      },
    },
    async (args) => {
      const { sandboxId, path, old_string, new_string, start_line, end_line } = args;

      // Validate mode
      if (old_string !== undefined && start_line !== undefined) {
        return error(
          'Provide either old_string (string mode) or start_line (line mode), not both.',
        );
      }
      if (old_string === undefined && start_line === undefined) {
        return error('Provide old_string (string mode) or start_line (line mode).');
      }

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return error('Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return error(
          'Invalid sandbox ID. Must be a numeric timestamp returned by write_ts or clone.',
        );
      }

      const sandboxPath = getSandboxPath(sandboxId);

      if (!isValidPath(sandboxPath, path)) {
        return error('Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      // Read existing content
      let content: string;
      try {
        content = await Bun.file(fullPath).text();
      } catch {
        return error(`File not found: ${path}`);
      }

      let newContent: string;

      if (old_string !== undefined) {
        // String mode
        if (!content.includes(old_string)) {
          return error(
            'old_string not found in file. Make sure it matches exactly (including whitespace).',
          );
        }

        const count = content.split(old_string).length - 1;
        if (count > 1) {
          return error(
            `old_string found ${count} times. Provide more surrounding context to make it unique.`,
          );
        }

        newContent = content.replace(old_string, new_string);
      } else {
        // Line mode
        const lines = content.split('\n');
        const endLine = end_line ?? start_line!;

        if (start_line! > lines.length) {
          return error(`start_line ${start_line} exceeds file length (${lines.length} lines).`);
        }
        if (endLine > lines.length) {
          return error(`end_line ${endLine} exceeds file length (${lines.length} lines).`);
        }
        if (endLine < start_line!) {
          return error('end_line must be >= start_line.');
        }

        const before = lines.slice(0, start_line! - 1);
        const after = lines.slice(endLine);
        newContent = [...before, new_string, ...after].join('\n');
      }

      await Bun.write(fullPath, newContent);

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
