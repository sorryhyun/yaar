/**
 * Shared HTTP helpers — JSON responses, error responses, path validation.
 */

import type { ServerResponse } from 'http';
import { normalize, join, relative } from 'path';

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, error: string, status = 500): void {
  sendJson(res, { error }, status);
}

/**
 * Validate and resolve a file path within a base directory.
 * Returns the resolved absolute path, or null if the path escapes the base.
 */
export function safePath(baseDir: string, filePath: string): string | null {
  const normalizedPath = normalize(join(baseDir, filePath));
  const rel = relative(baseDir, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) {
    return null;
  }
  return normalizedPath;
}
