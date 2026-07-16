/**
 * Shared HTTP helpers — JSON responses, error responses, path validation.
 */

import { normalize, join, relative } from 'path';
import { realpath } from 'fs/promises';
import { MAX_UPLOAD_SIZE } from '../config.js';
import { readBodyWithLimit, BodyTooLargeError } from './body-limit.js';

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

export interface ParseJsonBodyOptions {
  /** Reject bodies larger than this before buffering them. Defaults to MAX_UPLOAD_SIZE. */
  maxBytes?: number;
  /** Treat an empty body as `undefined` instead of a 400. */
  allowEmpty?: boolean;
}

/**
 * Read and JSON-parse a request body, returning either the value or the error
 * `Response` to send. Callers narrow with `if (body instanceof Response) return body`.
 *
 * Every JSON route wants the same three refusals — too large (413), empty (400),
 * unparseable (400) — and before this they each rewrote them, which is how the
 * `req.text()` routes ended up with no size limit at all: the limiter lived in the
 * copies that happened to be written after it. Going through here means a route
 * gets the limit by default rather than by remembering.
 */
export async function parseJsonBody<T>(
  req: Request,
  opts: ParseJsonBodyOptions & { allowEmpty: true },
): Promise<T | undefined | Response>;
export async function parseJsonBody<T>(
  req: Request,
  opts?: ParseJsonBodyOptions,
): Promise<T | Response>;
export async function parseJsonBody<T>(
  req: Request,
  opts: ParseJsonBodyOptions = {},
): Promise<T | undefined | Response> {
  const { maxBytes = MAX_UPLOAD_SIZE, allowEmpty = false } = opts;

  let raw: string;
  try {
    raw = (await readBodyWithLimit(req, maxBytes)).toString('utf-8');
  } catch (err) {
    if (err instanceof BodyTooLargeError) return errorResponse('Request body too large', 413);
    return errorResponse('Invalid JSON body', 400);
  }

  if (!raw.trim()) {
    return allowEmpty ? undefined : errorResponse('Empty body', 400);
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
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
