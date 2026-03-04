/**
 * basic:list — List directory contents by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import { ok, error } from '../utils.js';
import { parseUri } from './uri.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageList } from '../../storage/index.js';
import { listFiles, validateSandboxId, validateSandboxPath } from './helpers.js';

export function registerListTool(server: McpServer): void {
  server.registerTool(
    'list',
    {
      description:
        'List directory contents by URI. Supports sandbox:// and storage:// schemes.\n' +
        'Use sandbox://{sandboxId} to list sandbox root, or storage:// for storage root.',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'Directory URI. Examples: sandbox://123, sandbox://123/src, storage://, storage://docs',
          ),
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
        return error('Cannot list a new sandbox. Provide a sandbox ID.');
      }

      if (parsed.scheme === 'storage') {
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
      const idErr = validateSandboxId(parsed.sandboxId);
      if (idErr) return error(idErr);

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
