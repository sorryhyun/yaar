/**
 * Storage tools - read, write, list, delete files.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { storageRead, storageWrite, storageList, storageDelete } from '../../storage/index.js';
import { loadMounts, addMount, removeMount } from '../../storage/mounts.js';
import { actionEmitter } from '../action-emitter.js';
import { ok, okWithImages, error } from '../utils.js';

export const STORAGE_TOOL_NAMES = [
  'mcp__storage__read',
  'mcp__storage__write',
  'mcp__storage__list',
  'mcp__storage__delete',
  'mcp__storage__mount',
  'mcp__storage__unmount',
  'mcp__storage__list_mounts',
] as const;

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
        return error(result.error!);
      }

      if (result.images && result.images.length > 0) {
        const isPdf = result.totalPages != null;
        const hint = isPdf
          ? `\n\nTo display this PDF, create an iframe window with src="/api/storage/${args.path}" — the browser's built-in PDF viewer will render it. Do NOT try to describe or recreate the content in markdown.`
          : '';
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
      if (!result.success) return error(result.error!);
      return ok(`Written to ${args.path}`);
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
      if (!result.success) return error(result.error!);
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
      if (!result.success) return error(result.error!);
      return ok(`Deleted ${args.path}`);
    }
  );

  // mount — link a host directory into storage/mounts/{alias}/
  server.registerTool(
    'mount',
    {
      description:
        'Mount a host directory into storage/mounts/{alias}/ so all storage tools can access it. Requires user approval.',
      inputSchema: {
        alias: z
          .string()
          .describe('Short name for the mount (lowercase, alphanumeric + hyphens, e.g. "photos")'),
        hostPath: z.string().describe('Absolute path to the directory on the host filesystem'),
        readOnly: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, write and delete operations are blocked'),
      },
    },
    async (args) => {
      const roLabel = args.readOnly ? ' (read-only)' : '';
      const confirmed = await actionEmitter.showPermissionDialog(
        'Mount Directory',
        `Mount "${args.hostPath}" as storage://mounts/${args.alias}/${roLabel}?`,
        'storage_mount',
        args.hostPath,
      );

      if (!confirmed) {
        return error('User denied the mount request.');
      }

      const err = await addMount(args.alias, args.hostPath, args.readOnly);
      if (err) return error(err);
      return ok(`Mounted "${args.hostPath}" at mounts/${args.alias}/`);
    },
  );

  // unmount — remove a mount
  server.registerTool(
    'unmount',
    {
      description: 'Remove a mount from storage/mounts/',
      inputSchema: {
        alias: z.string().describe('Alias of the mount to remove'),
      },
    },
    async (args) => {
      const err = await removeMount(args.alias);
      if (err) return error(err);
      return ok(`Unmounted "${args.alias}"`);
    },
  );

  // list_mounts — show current mounts
  server.registerTool(
    'list_mounts',
    {
      description: 'List all mounted host directories',
      inputSchema: {},
    },
    async () => {
      const mounts = await loadMounts();
      if (mounts.length === 0) return ok('No mounts configured.');
      const lines = mounts.map(
        (m) =>
          `mounts/${m.alias}/ → ${m.hostPath}${m.readOnly ? ' (read-only)' : ''}`,
      );
      return ok(lines.join('\n'));
    },
  );
}
