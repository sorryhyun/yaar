/**
 * App development write tools - write_ts and apply_diff_ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { ok } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { isValidPath, generateSandboxId } from './helpers.js';

export function registerWriteTools(server: McpServer): void {
  // app_write_ts - Write TypeScript to sandbox
  server.registerTool(
    'write_ts',
    {
      description: `Write TypeScript code to a sandbox directory. Creates a new sandbox if sandboxId is not provided. Use this to develop apps before compiling. Entry point is src/main.ts. Split code into multiple files (e.g., src/utils.ts, src/renderer.ts) and import them from main.ts — avoid putting everything in one file.

BUNDLED LIBRARIES - Available via @bundled/* imports (no npm install needed):
• @bundled/uuid - Unique ID generation: v4(), v1(), validate()
• @bundled/lodash - Utilities: debounce, throttle, cloneDeep, groupBy, sortBy, uniq, chunk, etc.
• @bundled/date-fns - Date utilities: format, addDays, differenceInDays, isToday, etc.
• @bundled/clsx - CSS class names: clsx('foo', { bar: true })
• @bundled/anime - Animation library: anime({ targets, translateX, duration, easing })
• @bundled/konva - 2D canvas graphics: Stage, Layer, Rect, Circle, Text, etc.

STORAGE API - Available at runtime via window.yaar.storage (auto-injected, no import needed):
• save(path, data) - Write file (string | Blob | ArrayBuffer | Uint8Array)
• read(path, opts?) - Read file (opts.as: 'text'|'blob'|'arraybuffer'|'json'|'auto')
• list(dirPath?) - List directory → [{path, isDirectory, size, modifiedAt}]
• remove(path) - Delete file
• url(path) - Get URL string for <a>/<img>/etc.
Files are stored in the server's storage/ directory. Paths are relative (e.g., "myapp/data.json").

Example:
  import { v4 as uuid } from '@bundled/uuid';
  import anime from '@bundled/anime';
  import { format } from '@bundled/date-fns';
  // Storage (global, no import):
  // await yaar.storage.save('scores.json', JSON.stringify(data));
  // const data = await yaar.storage.read('scores.json', { as: 'json' });`,
      inputSchema: {
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        content: z.string().describe('TypeScript source code'),
        sandboxId: z.string().optional().describe('Sandbox ID. If omitted, creates a new sandbox with timestamp ID.'),
      },
    },
    async (args) => {
      const { path, content, sandboxId: providedId } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return ok('Error: Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID if provided (must be numeric timestamp)
      if (providedId && !/^\d+$/.test(providedId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp (from clone or a previous write_ts call). Do not use app names as sandbox IDs.');
      }

      // Create or use existing sandbox
      const sandboxId = providedId ?? generateSandboxId();
      const sandboxPath = getSandboxPath(sandboxId);

      // Validate the full path is within sandbox
      if (!isValidPath(sandboxPath, path)) {
        return ok('Error: Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      try {
        // Ensure parent directory exists
        await mkdir(dirname(fullPath), { recursive: true });

        // Write the file
        await writeFile(fullPath, content, 'utf-8');

        return ok(JSON.stringify({
          sandboxId,
          path,
          message: `File written to sandbox/${sandboxId}/${path}`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error: ${error}`);
      }
    }
  );

  // apply_diff_ts - Apply search-and-replace edit to a sandbox file
  server.registerTool(
    'apply_diff_ts',
    {
      description:
        'Apply a search-and-replace edit to an existing file in a sandbox. Finds the exact old_string and replaces it with new_string. Use this to revise code without rewriting the entire file.',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID containing the file'),
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        old_string: z.string().describe('The exact text to find (must be unique in the file)'),
        new_string: z.string().describe('The replacement text'),
      },
    },
    async (args) => {
      const { sandboxId, path, old_string, new_string } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return ok('Error: Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      if (!isValidPath(sandboxPath, path)) {
        return ok('Error: Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      // Read existing content
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        return ok(`Error: File not found: ${path}`);
      }

      // Check old_string exists
      if (!content.includes(old_string)) {
        return ok('Error: old_string not found in file. Make sure it matches exactly (including whitespace).');
      }

      // Check uniqueness
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        return ok(`Error: old_string found ${count} times. Provide more surrounding context to make it unique.`);
      }

      // Apply replacement
      const newContent = content.replace(old_string, new_string);
      await writeFile(fullPath, newContent, 'utf-8');

      return ok(JSON.stringify({
        sandboxId,
        path,
        message: `Applied edit to sandbox/${sandboxId}/${path}`,
      }, null, 2));
    }
  );
}
