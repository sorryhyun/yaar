/**
 * basic:delete — Delete a file by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { parseFileUri } from '@yaar/shared';
import { ok, error } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { storageDelete } from '../../storage/index.js';
import { validateSandboxPath } from './helpers.js';

export function registerDeleteTool(server: McpServer): void {
  server.registerTool(
    'delete',
    {
      description: 'Delete a file by URI (yaar://storage/... or yaar://sandbox/...).',
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
        if (!parsed.path) return error('Provide a file path to delete.');
        const result = await storageDelete(parsed.path);
        if (!result.success) return error(result.error!);
        return ok(`Deleted yaar://storage/${parsed.path}`);
      }

      // sandbox
      if (parsed.sandboxId === null) {
        return error('Cannot delete from a new sandbox. Provide a sandbox ID.');
      }
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
