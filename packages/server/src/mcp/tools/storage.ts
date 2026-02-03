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
        'Read a file from the persistent storage directory. For PDF files, returns page count - use /api/pdf/<path>/<page> URLs to display pages visually instead of describing them.',
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
        const pageCount = result.images.length;
        const hint = `\n\nTo display these pages visually, use image components with src="/api/pdf/${args.path}/<page>" where <page> is 1 to ${pageCount}.`;
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
