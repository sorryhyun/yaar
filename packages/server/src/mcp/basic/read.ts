/**
 * basic:read — Read a file by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { stat } from 'fs/promises';
import { join } from 'path';
import { ok, okWithImages, error } from '../utils.js';
import { parseUri } from './uri.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageRead } from '../../storage/index.js';
import { validateSandboxId, validateSandboxPath } from './helpers.js';

export function registerReadTool(server: McpServer): void {
  server.registerTool(
    'read',
    {
      description:
        'Read a file by URI. Supports sandbox:// and storage:// schemes.\n' +
        'For PDF files in storage, returns page count — display via iframe with storage:// protocol.\n' +
        'Set lineNumbers=true for numbered output (useful before calling edit with line mode).',
      inputSchema: {
        uri: z
          .string()
          .describe('File URI. Examples: sandbox://123/src/main.ts, storage://docs/readme.txt'),
        lineNumbers: z
          .boolean()
          .optional()
          .default(false)
          .describe('Prepend line numbers to each line (default: false)'),
      },
    },
    async (args) => {
      let parsed;
      try {
        parsed = parseUri(args.uri);
      } catch (e) {
        return error((e as Error).message);
      }

      if (parsed.scheme === 'sandbox-new') {
        return error('Cannot read from sandbox:/// (new sandbox). Provide a sandbox ID.');
      }

      if (parsed.scheme === 'storage') {
        if (!parsed.path) {
          return error('Cannot read a directory. Use list instead.');
        }
        const result = await storageRead(parsed.path);
        if (!result.success) return error(result.error!);

        if (result.images && result.images.length > 0) {
          const isPdf = result.totalPages != null;
          const hint = isPdf
            ? `\n\nTo display this PDF, create an iframe window with content="storage://${parsed.path}" — the browser's built-in PDF viewer will render it. Do NOT try to describe or recreate the content in markdown.`
            : '';
          return okWithImages(
            result.content! + hint,
            result.images.map((img) => ({ data: img.data, mimeType: img.mimeType })),
          );
        }

        // Storage already returns line-numbered text for text files.
        // If lineNumbers=false, strip them out; if true, return as-is.
        if (!args.lineNumbers && result.content) {
          // storageRead always adds line numbers, strip them if not wanted
          const headerMatch = result.content.match(/^── .+ \(\d+ lines\) ──\n/);
          if (headerMatch) {
            const body = result.content.slice(headerMatch[0].length);
            const stripped = body
              .split('\n')
              .map((line) => line.replace(/^\s*\d+│/, ''))
              .join('\n');
            return ok(stripped);
          }
        }
        return ok(result.content!);
      }

      // sandbox scheme
      const idErr = validateSandboxId(parsed.sandboxId);
      if (idErr) return error(idErr);

      const sandboxPath = getSandboxPath(parsed.sandboxId);

      if (!parsed.path) {
        return error('Cannot read a directory. Use list instead.');
      }

      const pathErr = validateSandboxPath(parsed.path, sandboxPath);
      if (pathErr) return error(pathErr);

      const fullPath = join(sandboxPath, parsed.path);

      try {
        const info = await stat(fullPath);
        if (info.isDirectory()) {
          return error('Cannot read a directory. Use list instead.');
        }
        const content = await Bun.file(fullPath).text();
        if (args.lineNumbers) {
          const lines = content.split('\n');
          const width = String(lines.length).length;
          const numbered = lines
            .map((line, i) => `${String(i + 1).padStart(width)}│${line}`)
            .join('\n');
          return ok(`── ${parsed.path} (${lines.length} lines) ──\n${numbered}`);
        }
        return ok(content);
      } catch {
        return error(`File not found: ${parsed.path}`);
      }
    },
  );
}
