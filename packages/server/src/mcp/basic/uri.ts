/**
 * URI parser for the basic MCP namespace.
 *
 * Thin adapter over parseFileUri() from @yaar/shared.
 * Accepts yaar://, storage://, and sandbox:// URIs.
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
 *   parseUri('sandbox://123/src/main.ts') → { scheme: 'sandbox', sandboxId: '123', path: 'src/main.ts' }
 *   parseUri('sandbox:///src/main.ts')    → { scheme: 'sandbox-new', path: 'src/main.ts' }
 *   parseUri('sandbox://123')             → { scheme: 'sandbox', sandboxId: '123', path: '' }
 *   parseUri('storage://docs/file.txt')   → { scheme: 'storage', path: 'docs/file.txt' }
 *   parseUri('storage://')                → { scheme: 'storage', path: '' }
 *   parseUri('yaar://storage/docs/f.txt') → { scheme: 'storage', path: 'docs/f.txt' }
 *   parseUri('yaar://sandbox/123/main.ts')→ { scheme: 'sandbox', sandboxId: '123', path: 'main.ts' }
 */
export function parseUri(uri: string): ParsedUri {
  const parsed = parseFileUri(uri);
  if (!parsed) {
    throw new Error(
      `Invalid URI: "${uri}". Expected yaar://storage/{path}, yaar://sandbox/{id}/{path}, sandbox://{id}/{path}, or storage://{path}.`,
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
