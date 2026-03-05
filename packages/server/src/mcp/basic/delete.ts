/**
 * basic:delete — Delete a file by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { ok, error } from '../utils.js';
import { parseUri } from './uri.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageDelete } from '../../storage/index.js';
import { validateSandboxPath } from './helpers.js';

export function registerDeleteTool(server: McpServer): void {
  server.registerTool(
    'delete',
    {
      description: 'Delete a file by URI (yaar://storage/... or yaar://sandbox/...).',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'File URI. Examples: yaar://sandbox/123/src/old.ts, yaar://storage/docs/draft.txt',
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
        return error('Cannot delete from a new sandbox. Provide a sandbox ID.');
      }

      if (parsed.scheme === 'storage') {
        if (!parsed.path) return error('Provide a file path to delete.');
        const result = await storageDelete(parsed.path);
        if (!result.success) return error(result.error!);
        return ok(`Deleted yaar://storage/${parsed.path}`);
      }

      // sandbox
      if (!parsed.path) return error('Provide a file path to delete.');

      const sandboxPath = getSandboxPath(parsed.sandboxId);
      const pathErr = validateSandboxPath(parsed.path, sandboxPath);
      if (pathErr) return error(pathErr);

      const fullPath = join(sandboxPath, parsed.path);

      try {
        await unlink(fullPath);
        return ok(`Deleted yaar://sandbox/${parsed.sandboxId}/${parsed.path}`);
      } catch {
        return error(`File not found: ${parsed.path}`);
      }
    },
  );
}
