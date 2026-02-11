/**
 * App development read tool - read_ts for reading sandbox files.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { ok } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { isValidPath } from './helpers.js';

/**
 * Recursively list all files under a directory, returning relative paths.
 */
async function listFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full, base));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'read_ts',
    {
      description:
        'Read a file from a sandbox directory. If path is omitted, lists all files in the sandbox.',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID'),
        path: z.string().optional().describe('Relative path in sandbox (e.g., "src/main.ts"). Omit to list all files.'),
      },
    },
    async (args) => {
      const { sandboxId, path } = args;

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      // If no path, list files
      if (!path) {
        try {
          const files = await listFiles(sandboxPath, sandboxPath);
          return ok(JSON.stringify({ sandboxId, files }, null, 2));
        } catch {
          return ok(`Error: Sandbox not found: ${sandboxId}`);
        }
      }

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return ok('Error: Invalid path. Use relative paths without ".." or leading "/".');
      }

      if (!isValidPath(sandboxPath, path)) {
        return ok('Error: Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      try {
        const info = await stat(fullPath);
        if (info.isDirectory()) {
          const files = await listFiles(fullPath, sandboxPath);
          return ok(JSON.stringify({ sandboxId, path, files }, null, 2));
        }
        const content = await readFile(fullPath, 'utf-8');
        return ok(JSON.stringify({ sandboxId, path, content }, null, 2));
      } catch {
        return ok(`Error: File not found: ${path}`);
      }
    }
  );
}
