/**
 * basic:edit — Apply an edit to a file by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import { ok, error } from '../utils.js';
import { parseUri } from './uri.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageRead, storageWrite } from '../../storage/index.js';
import { validateSandboxPath } from './helpers.js';

export function registerEditTool(server: McpServer): void {
  server.registerTool(
    'edit',
    {
      description:
        'Apply an edit to a file by URI. Two modes:\n' +
        '1. String mode: provide old_string + new_string (finds exact match and replaces)\n' +
        '2. Line mode: provide start_line + new_string (replaces lines start_line..end_line)\n' +
        'Line numbers are 1-based, matching the output of read with lineNumbers=true.',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'File URI. Examples: yaar://sandbox/123/src/main.ts, yaar://storage/docs/readme.txt',
          ),
        old_string: z
          .string()
          .optional()
          .describe('Exact text to find (must be unique). Omit to use line mode.'),
        new_string: z.string().describe('Replacement text'),
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
          .describe('Last line to replace (1-based, inclusive). Defaults to start_line.'),
      },
    },
    async (args) => {
      const { old_string, new_string, start_line, end_line } = args;

      // Validate mode
      if (old_string !== undefined && start_line !== undefined) {
        return error(
          'Provide either old_string (string mode) or start_line (line mode), not both.',
        );
      }
      if (old_string === undefined && start_line === undefined) {
        return error('Provide old_string (string mode) or start_line (line mode).');
      }

      let parsed;
      try {
        parsed = parseUri(args.uri);
      } catch (e) {
        return error((e as Error).message);
      }

      if (parsed.scheme === 'sandbox-new') {
        return error('Cannot edit a new sandbox file. Write first, then edit.');
      }

      // Read existing content
      let content: string;

      if (parsed.scheme === 'storage') {
        if (!parsed.path) return error('Provide a file path to edit.');
        const readResult = await storageRead(parsed.path);
        if (!readResult.success) return error(readResult.error!);
        if (!readResult.content) return error('Cannot edit binary files.');
        // storageRead adds line numbers — we need raw content
        // Re-read directly via Bun to get raw text
        const { resolvePath } = await import('../../storage/storage-manager.js');
        const resolved = resolvePath(parsed.path);
        if (!resolved) return error('Invalid storage path.');
        try {
          content = await Bun.file(resolved.absolutePath).text();
        } catch {
          return error(`File not found: ${parsed.path}`);
        }
      } else {
        // sandbox
        if (!parsed.path) return error('Provide a file path to edit.');

        const sandboxPath = getSandboxPath(parsed.sandboxId);
        const pathErr = validateSandboxPath(parsed.path, sandboxPath);
        if (pathErr) return error(pathErr);

        const fullPath = join(sandboxPath, parsed.path);
        try {
          content = await Bun.file(fullPath).text();
        } catch {
          return error(`File not found: ${parsed.path}`);
        }
      }

      // Apply edit
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

      // Write back
      if (parsed.scheme === 'storage') {
        const result = await storageWrite(parsed.path, newContent);
        if (!result.success) return error(result.error!);
        return ok(`Edited yaar://storage/${parsed.path}`);
      }

      // sandbox
      const fullPath = join(getSandboxPath(parsed.sandboxId), parsed.path);
      await Bun.write(fullPath, newContent);
      return ok(
        JSON.stringify(
          {
            sandboxId: parsed.sandboxId,
            path: parsed.path,
            message: `Edited yaar://sandbox/${parsed.sandboxId}/${parsed.path}`,
          },
          null,
          2,
        ),
      );
    },
  );
}
