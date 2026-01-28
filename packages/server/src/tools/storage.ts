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

    return {
      content: [{
        type: 'text' as const,
        text: result.success
          ? result.content!
          : JSON.stringify({ success: false, error: result.error })
      }]
    };
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2)
      }]
    };
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2)
      }]
    };
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2)
      }]
    };
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
