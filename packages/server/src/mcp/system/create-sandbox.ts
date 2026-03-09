/**
 * create_sandbox tool - explicitly create a new sandbox directory.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir } from 'fs/promises';
import { ok } from '../utils.js';
import { generateSandboxId } from '../legacy/dev/helpers.js';
import { getSandboxPath } from '../../lib/compiler/index.js';

export function registerCreateSandboxTools(server: McpServer): void {
  server.registerTool(
    'create_sandbox',
    {
      description:
        'Create a new empty sandbox directory for app development. Returns a sandbox ID for use with write, read, compile, and deploy.',
      inputSchema: {},
    },
    async () => {
      const sandboxId = generateSandboxId();
      const sandboxPath = getSandboxPath(sandboxId);

      await mkdir(sandboxPath, { recursive: true });

      return ok(
        JSON.stringify(
          {
            sandboxId,
            message: `Sandbox ${sandboxId} created. Write files using paths like "yaar://sandbox/${sandboxId}/src/main.ts", then compile and deploy.`,
          },
          null,
          2,
        ),
      );
    },
  );
}
