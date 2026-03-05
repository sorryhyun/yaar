/**
 * basic:write — Write a file by URI.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { ok, error } from '../utils.js';
import { parseUri } from './uri.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { generateSandboxId } from '../dev/helpers.js';
import { storageWrite } from '../../storage/index.js';
import { validateSandboxPath } from './helpers.js';

export function registerWriteTool(server: McpServer): void {
  server.registerTool(
    'write',
    {
      description:
        'Write a file by URI (yaar://storage/... or yaar://sandbox/...).\n' +
        'Use yaar://sandbox/new/path to create a new sandbox automatically.',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'File URI. Examples: yaar://sandbox/123/src/main.ts, yaar://sandbox/new/src/main.ts (new sandbox), yaar://storage/docs/file.txt',
          ),
        content: z.string().describe('Content to write'),
      },
    },
    async (args) => {
      let parsed;
      try {
        parsed = parseUri(args.uri);
      } catch (e) {
        return error((e as Error).message);
      }

      if (parsed.scheme === 'storage') {
        if (!parsed.path) return error('Cannot write to storage root. Provide a file path.');
        const result = await storageWrite(parsed.path, args.content);
        if (!result.success) return error(result.error!);
        return ok(`Written to yaar://storage/${parsed.path}`);
      }

      // sandbox or sandbox-new
      let sandboxId: string;
      let path: string;

      if (parsed.scheme === 'sandbox-new') {
        if (!parsed.path) return error('Provide a file path (e.g. sandbox:///src/main.ts).');
        sandboxId = generateSandboxId();
        path = parsed.path;
      } else {
        if (!parsed.path) return error('Provide a file path within the sandbox.');
        sandboxId = parsed.sandboxId;
        path = parsed.path;
      }

      const sandboxPath = getSandboxPath(sandboxId);
      const pathErr = validateSandboxPath(path, sandboxPath);
      if (pathErr) return error(pathErr);

      const fullPath = join(sandboxPath, path);

      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await Bun.write(fullPath, args.content);
        return ok(
          JSON.stringify(
            { sandboxId, path, message: `Written to yaar://sandbox/${sandboxId}/${path}` },
            null,
            2,
          ),
        );
      } catch (err) {
        return error(err instanceof Error ? err.message : 'Unknown error');
      }
    },
  );
}
