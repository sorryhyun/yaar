/**
 * Shared helpers for the basic MCP namespace.
 */

import { readdir } from 'fs/promises';
import { join, relative } from 'path';
import { isValidPath } from '../dev/helpers.js';

/** Recursively list all files under a directory, returning relative paths. */
export async function listFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, base)));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

/** Validate sandbox ID is a numeric timestamp. */
export function validateSandboxId(id: string): string | null {
  if (!/^\d+$/.test(id)) {
    return 'Invalid sandbox ID. Must be a numeric timestamp returned by write or clone.';
  }
  return null;
}

/** Common path validation for sandbox. */
export function validateSandboxPath(path: string, sandboxPath: string): string | null {
  if (path.includes('..') || path.startsWith('/')) {
    return 'Invalid path. Use relative paths without ".." or leading "/".';
  }
  if (!isValidPath(sandboxPath, path)) {
    return 'Path escapes sandbox directory.';
  }
  return null;
}
