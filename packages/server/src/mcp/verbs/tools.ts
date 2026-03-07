/**
 * 5 generic verb tools — describe, read, list, invoke, delete.
 *
 * Each tool delegates to ResourceRegistry.execute() so all URI-specific
 * logic lives in domain handler files, not here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ResourceRegistry } from '../../uri/registry.js';

/** Spread to satisfy MCP SDK's index-signature requirement on tool results. */
const exec = async (
  registry: ResourceRegistry,
  ...args: Parameters<ResourceRegistry['execute']>
) => {
  const result = await registry.execute(...args);
  return { ...result };
};

export function registerVerbTools(server: McpServer, registry: ResourceRegistry): void {
  server.registerTool(
    'describe',
    {
      description:
        'Describe a yaar:// resource — returns supported verbs, description, and invoke schema.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to describe'),
      },
    },
    async ({ uri }) => exec(registry, 'describe', uri),
  );

  server.registerTool(
    'read',
    {
      description: 'Read the current value/state of a yaar:// resource.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to read'),
      },
    },
    async ({ uri }) => exec(registry, 'read', uri),
  );

  server.registerTool(
    'list',
    {
      description: 'List child resources under a yaar:// URI.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to list children of'),
      },
    },
    async ({ uri }) => exec(registry, 'list', uri),
  );

  server.registerTool(
    'invoke',
    {
      description: 'Invoke an action on a yaar:// resource (create, update, trigger).',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to invoke'),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Action-specific payload (see describe for schema)'),
      },
    },
    async ({ uri, payload }) => exec(registry, 'invoke', uri, payload),
  );

  server.registerTool(
    'delete',
    {
      description: 'Delete a yaar:// resource.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to delete'),
      },
    },
    async ({ uri }) => exec(registry, 'delete', uri),
  );
}
