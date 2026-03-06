/**
 * Shared HTTP helpers — JSON responses, error responses, path validation.
 */

import { normalize, join, relative } from 'path';
import { realpath } from 'fs/promises';

/** Metadata for a public REST endpoint exposed to iframe apps. */
export interface EndpointMeta {
  method: string;
  path: string;
  response: string;
  description: string;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function errorResponse(error: string, status = 500): Response {
  return Response.json({ error }, { status });
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

/**
 * Async variant of safePath that resolves symlinks before containment check.
 * Falls back to sync normalize check when target doesn't exist yet (write ops).
 */
export async function safePathAsync(baseDir: string, filePath: string): Promise<string | null> {
  const normalizedPath = normalize(join(baseDir, filePath));
  const rel = relative(baseDir, normalizedPath);
  if (rel.startsWith('..') || rel.includes('..')) {
    return null;
  }
  try {
    const realPath = await realpath(normalizedPath);
    const realBase = await realpath(baseDir);
    const realRel = relative(realBase, realPath);
    if (realRel.startsWith('..') || realRel.includes('..')) {
      return null;
    }
    return realPath;
  } catch {
    // File doesn't exist yet (e.g., write operations) — fall back to sync check
    return normalizedPath;
  }
}
