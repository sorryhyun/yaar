/**
 * URI parser for the basic MCP namespace.
 *
 * Thin adapter over parseFileUri() from @yaar/shared.
 * Accepts yaar://storage/ and yaar://sandbox/ URIs (plus legacy storage:// and sandbox://).
 */

import { parseFileUri } from '@yaar/shared';

export type ParsedUri =
  | { scheme: 'sandbox'; sandboxId: string; path: string }
  | { scheme: 'sandbox-new'; path: string }
  | { scheme: 'storage'; path: string };

/**
 * Parse a URI string into a structured object.
 *
 * @example
 *   parseUri('yaar://storage/docs/f.txt')  → { scheme: 'storage', path: 'docs/f.txt' }
 *   parseUri('yaar://storage/')            → { scheme: 'storage', path: '' }
 *   parseUri('yaar://sandbox/123/main.ts') → { scheme: 'sandbox', sandboxId: '123', path: 'main.ts' }
 *   parseUri('yaar://sandbox/new/main.ts') → { scheme: 'sandbox-new', path: 'main.ts' }
 *   // Legacy forms (still accepted for backward compat):
 *   parseUri('storage://docs/file.txt')    → { scheme: 'storage', path: 'docs/file.txt' }
 *   parseUri('sandbox://123/src/main.ts')  → { scheme: 'sandbox', sandboxId: '123', path: 'src/main.ts' }
 *   parseUri('sandbox:///src/main.ts')     → { scheme: 'sandbox-new', path: 'src/main.ts' }
 */
export function parseUri(uri: string): ParsedUri {
  const parsed = parseFileUri(uri);
  if (!parsed) {
    throw new Error(
      `Invalid URI: "${uri}". Expected yaar://storage/{path} or yaar://sandbox/{id}/{path}.`,
    );
  }
  if (parsed.authority === 'storage') {
    return { scheme: 'storage', path: parsed.path };
  }
  if (parsed.sandboxId === null) {
    return { scheme: 'sandbox-new', path: parsed.path };
  }
  return { scheme: 'sandbox', sandboxId: parsed.sandboxId, path: parsed.path };
}
