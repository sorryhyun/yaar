/**
 * basic:list — List directory contents by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import { parseFileUri } from '@yaar/shared';
import { ok, error } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageList } from '../../storage/index.js';
import { listFiles, validateSandboxPath } from './helpers.js';

export function registerListTool(server: McpServer): void {
  server.registerTool(
    'list',
    {
      description:
        'List directory contents by URI (yaar://storage/... or yaar://sandbox/...).\n' +
        'Use yaar://sandbox/{sandboxId} to list sandbox root, or yaar://storage to list storage root.',
      inputSchema: {
        uri: z.string(),
      },
    },
    async (args) => {
      const parsed = parseFileUri(args.uri);
      if (!parsed) {
        return error('Invalid URI. Expected yaar://storage/{path} or yaar://sandbox/{id}/{path}.');
      }

      if (parsed.authority === 'storage') {
        const result = await storageList(parsed.path);
        if (!result.success) return error(result.error!);
        const text =
          result.entries!.length === 0
            ? 'Directory is empty'
            : result
                .entries!.map((e) => `${e.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4'} ${e.path}`)
                .join('\n');
        return ok(text);
      }

      // sandbox
      if (parsed.sandboxId === null) {
        return error('Cannot list a new sandbox. Provide a sandbox ID.');
      }
      const sandboxPath = getSandboxPath(parsed.sandboxId);

      try {
        const targetDir = parsed.path ? join(sandboxPath, parsed.path) : sandboxPath;
        // Validate path if specified
        if (parsed.path) {
          const pathErr = validateSandboxPath(parsed.path, sandboxPath);
          if (pathErr) return error(pathErr);
        }
        const files = await listFiles(targetDir, sandboxPath);
        return ok(JSON.stringify({ sandboxId: parsed.sandboxId, files }, null, 2));
      } catch {
        return error(`Sandbox not found: ${parsed.sandboxId}`);
      }
    },
  );
}
