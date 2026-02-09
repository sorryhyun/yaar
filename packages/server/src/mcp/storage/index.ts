/**
 * Storage tools - read, write, list, delete files.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { storageRead, storageWrite, storageList, storageDelete } from '../../storage/index.js';
import { ok, okWithImages } from '../utils.js';

export function registerStorageTools(server: McpServer): void {
  // storage_read
  server.registerTool(
    'read',
    {
      description:
        'Read a file from the persistent storage directory. For PDF files, returns page count — display them by creating an iframe window with src="/api/storage/<path>" to use the browser\'s built-in PDF viewer. NEVER render PDF content as markdown.',
      inputSchema: {
        path: z.string().describe('Path to the file relative to storage/'),
      },
    },
    async (args) => {
      const result = await storageRead(args.path);
      if (!result.success) {
        return ok(`Error: ${result.error}`);
      }

      if (result.images && result.images.length > 0) {
        const hint = `\n\nTo display this PDF, create an iframe window with src="/api/storage/${args.path}" — the browser's built-in PDF viewer will render it. Do NOT try to describe or recreate the content in markdown.`;
        return okWithImages(
          result.content! + hint,
          result.images.map((img) => ({ data: img.data, mimeType: img.mimeType }))
        );
      }

      return ok(result.content!);
    }
  );

  // storage_write
  server.registerTool(
    'write',
    {
      description: 'Write a file to the persistent storage directory',
      inputSchema: {
        path: z.string().describe('Path to the file relative to storage/'),
        content: z.string().describe('Content to write to the file'),
      },
    },
    async (args) => {
      const result = await storageWrite(args.path, args.content);
      return ok(result.success ? `Written to ${args.path}` : `Error: ${result.error}`);
    }
  );

  // storage_list
  server.registerTool(
    'list',
    {
      description: 'List files and directories in the persistent storage directory',
      inputSchema: {
        path: z.string().optional().describe('Path to list relative to storage/. Defaults to root.'),
      },
    },
    async (args) => {
      const result = await storageList(args.path || '');
      if (!result.success) return ok(`Error: ${result.error}`);
      const text =
        result.entries!.length === 0
          ? 'Directory is empty'
          : result.entries!.map((e) => `${e.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4'} ${e.path}`).join('\n');
      return ok(text);
    }
  );

  // storage_delete
  server.registerTool(
    'delete',
    {
      description: 'Delete a file from the persistent storage directory',
      inputSchema: {
        path: z.string().describe('Path to the file to delete relative to storage/'),
      },
    },
    async (args) => {
      const result = await storageDelete(args.path);
      return ok(result.success ? `Deleted ${args.path}` : `Error: ${result.error}`);
    }
  );
}
