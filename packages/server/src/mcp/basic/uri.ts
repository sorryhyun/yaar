/**
 * URI parser for the basic MCP namespace.
 *
 * Supported schemes:
 *   sandbox://{sandboxId}/{path}  → existing sandbox file
 *   sandbox:///{path}             → new sandbox (write/edit only)
 *   sandbox://{sandboxId}         → sandbox root (list only)
 *   storage://{path}              → persistent storage file
 *   storage://                    → storage root (list only)
 */

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
 */
export function parseUri(uri: string): ParsedUri {
  // Match sandbox:// or storage://
  const match = uri.match(/^(sandbox|storage):\/\/(.*)$/);
  if (!match) {
    throw new Error(
      `Invalid URI: "${uri}". Expected sandbox://{sandboxId}/{path}, sandbox:///{path}, or storage://{path}.`,
    );
  }

  const [, scheme, rest] = match;

  if (scheme === 'storage') {
    // storage://{path} or storage://
    return { scheme: 'storage', path: rest };
  }

  // sandbox scheme
  if (rest.startsWith('/')) {
    // sandbox:///{path} → new sandbox (triple slash = empty authority)
    return { scheme: 'sandbox-new', path: rest.slice(1) };
  }

  // sandbox://{sandboxId}/{path} or sandbox://{sandboxId}
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    // sandbox://{sandboxId} — root listing
    return { scheme: 'sandbox', sandboxId: rest, path: '' };
  }

  return {
    scheme: 'sandbox',
    sandboxId: rest.slice(0, slashIdx),
    path: rest.slice(slashIdx + 1),
  };
}
