/**
 * Storage tools for ClaudeOS.
 *
 * Provides tools for:
 * - Reading files from storage
 * - Writing files to storage
 * - Listing files in storage
 * - Deleting files from storage
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../storage/index.js';

/** Helper to create MCP tool result */
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/**
 * Read a file from storage.
 */
export const storageReadTool = tool(
  'storage_read',
  'Read a file from the persistent storage directory',
  {
    path: z.string().describe('Path to the file relative to storage/')
  },
  async (args) => {
    const result = await storageRead(args.path);
    return ok(result.success ? result.content! : `Error: ${result.error}`);
  }
);

/**
 * Write a file to storage.
 */
export const storageWriteTool = tool(
  'storage_write',
  'Write a file to the persistent storage directory',
  {
    path: z.string().describe('Path to the file relative to storage/'),
    content: z.string().describe('Content to write to the file')
  },
  async (args) => {
    const result = await storageWrite(args.path, args.content);
    return ok(result.success ? `Written to ${args.path}` : `Error: ${result.error}`);
  }
);

/**
 * List files in storage.
 */
export const storageListTool = tool(
  'storage_list',
  'List files and directories in the persistent storage directory',
  {
    path: z.string().optional().describe('Path to list relative to storage/. Defaults to root.')
  },
  async (args) => {
    const result = await storageList(args.path || '');
    if (!result.success) return ok(`Error: ${result.error}`);
    const text = result.entries!.length === 0
      ? 'Directory is empty'
      : result.entries!.map(e => `${e.isDirectory ? '📁' : '📄'} ${e.path}`).join('\n');
    return ok(text);
  }
);

/**
 * Delete a file from storage.
 */
export const storageDeleteTool = tool(
  'storage_delete',
  'Delete a file from the persistent storage directory',
  {
    path: z.string().describe('Path to the file to delete relative to storage/')
  },
  async (args) => {
    const result = await storageDelete(args.path);
    return ok(result.success ? `Deleted ${args.path}` : `Error: ${result.error}`);
  }
);

/**
 * All storage tools.
 */
export const storageTools = [
  storageReadTool,
  storageWriteTool,
  storageListTool,
  storageDeleteTool
];
