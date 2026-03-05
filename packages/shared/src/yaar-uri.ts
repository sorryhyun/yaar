/**
 * YAAR URI scheme — unified addressing for apps, storage, sandbox, and window resources.
 *
 * Format: yaar://{authority}/{path}
 *
 * Content resources:
 *   yaar://apps/{appId}                → app (resolved to iframe URL)
 *   yaar://storage/{path}              → persistent storage file
 *   yaar://sandbox/{sandboxId}/{path}  → sandbox file
 *
 * File-operation URIs (for basic MCP tools):
 *   yaar://storage/{path}              → persistent storage file
 *   yaar://sandbox/{sandboxId}/{path}  → existing sandbox file
 *   yaar://sandbox/new/{path}          → new sandbox (write/edit only)
 *
 * Window addressing:
 *   yaar://{monitorId}/{windowId}      → window on a monitor
 */

export type YaarAuthority = 'apps' | 'storage' | 'sandbox';

export interface ParsedYaarUri {
  authority: YaarAuthority;
  path: string;
}

const YAAR_RE = /^yaar:\/\/(apps|storage|sandbox)\/(.*)$/;

export function parseYaarUri(uri: string): ParsedYaarUri | null {
  const match = uri.match(YAAR_RE);
  if (!match) return null;
  return { authority: match[1] as YaarAuthority, path: match[2] };
}

export function buildYaarUri(authority: YaarAuthority, path: string): string {
  return `yaar://${authority}/${path}`;
}

export function isYaarUri(uri: string): boolean {
  return YAAR_RE.test(uri);
}

/**
 * Resolve a yaar:// URI to an API path.
 *
 *   yaar://apps/{appId}           → /api/apps/{appId}/index.html
 *   yaar://apps/{appId}/{subpath} → /api/apps/{appId}/{subpath}
 *   yaar://storage/{path}         → /api/storage/{path}
 *   yaar://sandbox/{id}/{path}    → /api/sandbox/{id}/{path}
 */
export function resolveContentUri(uri: string): string | null {
  const parsed = parseYaarUri(uri);
  if (!parsed) return null;
  switch (parsed.authority) {
    case 'apps': {
      const slashIdx = parsed.path.indexOf('/');
      if (slashIdx === -1) return `/api/apps/${parsed.path}/index.html`;
      return `/api/apps/${parsed.path}`;
    }
    case 'storage':
      return `/api/storage/${parsed.path}`;
    case 'sandbox':
      return `/api/sandbox/${parsed.path}`;
  }
}

/**
 * Extract app ID from a yaar://apps/{appId} URI.
 */
export function extractAppId(uri: string): string | null {
  const parsed = parseYaarUri(uri);
  if (parsed?.authority === 'apps') {
    const slashIdx = parsed.path.indexOf('/');
    return slashIdx === -1 ? parsed.path : parsed.path.slice(0, slashIdx);
  }
  return null;
}

// ============ File-operation URIs ============

/** Sandbox IDs are numeric timestamps (e.g. Date.now().toString()). */
const SANDBOX_ID_RE = /^\d+$/;

export type ParsedContentPath =
  | { authority: 'storage'; path: string }
  | { authority: 'sandbox'; sandboxId: string; path: string }
  | { authority: 'apps'; appId: string; path: string };

/** App IDs are kebab-case: starts with lowercase letter, then lowercase letters, digits, or hyphens. */
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

export type ParsedFileUri =
  | { authority: 'storage'; path: string }
  | { authority: 'sandbox'; sandboxId: string; path: string }
  | { authority: 'sandbox'; sandboxId: null; path: string };

/**
 * Parse a file-operation URI (yaar://, storage://, sandbox://).
 *
 * Sandbox IDs must be numeric timestamps or "new" (for new sandbox creation).
 *
 *   yaar://storage/docs/file.txt      → { authority: 'storage', path: 'docs/file.txt' }
 *   yaar://sandbox/123/src/main.ts    → { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }
 *   yaar://sandbox/new/src/main.ts    → { authority: 'sandbox', sandboxId: null, path: 'src/main.ts' }
 *   storage://docs/file.txt           → { authority: 'storage', path: 'docs/file.txt' }  (legacy)
 *   sandbox://123/src/main.ts         → { authority: 'sandbox', sandboxId: '123', ... }  (legacy)
 *   sandbox:///src/main.ts            → { authority: 'sandbox', sandboxId: null, ... }   (legacy)
 */
export function parseFileUri(uri: string): ParsedFileUri | null {
  // yaar:// scheme
  const parsed = parseYaarUri(uri);
  if (parsed) {
    if (parsed.authority === 'storage') {
      return { authority: 'storage', path: parsed.path };
    }
    if (parsed.authority === 'sandbox') {
      const slashIdx = parsed.path.indexOf('/');
      if (slashIdx === -1) {
        // yaar://sandbox/{sandboxId} — root
        if (!SANDBOX_ID_RE.test(parsed.path)) return null;
        return { authority: 'sandbox', sandboxId: parsed.path, path: '' };
      }
      const first = parsed.path.slice(0, slashIdx);
      const rest = parsed.path.slice(slashIdx + 1);
      if (first === 'new') {
        return { authority: 'sandbox', sandboxId: null, path: rest };
      }
      if (!SANDBOX_ID_RE.test(first)) return null;
      return { authority: 'sandbox', sandboxId: first, path: rest };
    }
    return null; // apps authority not a file URI
  }

  // Legacy: storage://{path}
  const storageMatch = uri.match(/^storage:\/\/(.*)$/);
  if (storageMatch) {
    return { authority: 'storage', path: storageMatch[1] };
  }

  // Legacy: sandbox://{sandboxId}/{path} or sandbox:///{path}
  const sandboxMatch = uri.match(/^sandbox:\/\/(.*)$/);
  if (sandboxMatch) {
    const rest = sandboxMatch[1];
    if (rest.startsWith('/')) {
      // sandbox:///{path} → new sandbox
      return { authority: 'sandbox', sandboxId: null, path: rest.slice(1) };
    }
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      if (!SANDBOX_ID_RE.test(rest)) return null;
      return { authority: 'sandbox', sandboxId: rest, path: '' };
    }
    const id = rest.slice(0, slashIdx);
    if (!SANDBOX_ID_RE.test(id)) return null;
    return {
      authority: 'sandbox',
      sandboxId: id,
      path: rest.slice(slashIdx + 1),
    };
  }

  return null;
}

/**
 * Parse an API pathname back into a ParsedContentPath.
 * Reverse of resolveContentUri() for storage/sandbox/apps paths.
 *
 *   /api/storage/docs/file.txt      → { authority: 'storage', path: 'docs/file.txt' }
 *   /api/sandbox/123/src/main.ts    → { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }
 *   /api/apps/dock/index.html       → { authority: 'apps', appId: 'dock', path: 'index.html' }
 */
export function parseContentPath(pathname: string): ParsedContentPath | null {
  if (pathname.startsWith('/api/storage/')) {
    return { authority: 'storage', path: pathname.slice('/api/storage/'.length) };
  }
  if (pathname.startsWith('/api/sandbox/')) {
    const rest = pathname.slice('/api/sandbox/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      if (!SANDBOX_ID_RE.test(rest)) return null;
      return { authority: 'sandbox', sandboxId: rest, path: '' };
    }
    const id = rest.slice(0, slashIdx);
    if (!SANDBOX_ID_RE.test(id)) return null;
    return { authority: 'sandbox', sandboxId: id, path: rest.slice(slashIdx + 1) };
  }
  if (pathname.startsWith('/api/apps/')) {
    const rest = pathname.slice('/api/apps/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return null; // No path after appId
    const appId = rest.slice(0, slashIdx);
    if (!APP_ID_RE.test(appId)) return null;
    const path = rest.slice(slashIdx + 1);
    if (!path) return null; // Empty path after slash
    return { authority: 'apps', appId, path };
  }
  return null;
}

/**
 * Build a yaar:// file-operation URI.
 *
 *   buildFileUri('storage', 'docs/file.txt')       → 'yaar://storage/docs/file.txt'
 *   buildFileUri('sandbox', '123', 'src/main.ts')   → 'yaar://sandbox/123/src/main.ts'
 *   buildFileUri('sandbox', null, 'src/main.ts')    → 'yaar://sandbox/new/src/main.ts'
 */
export function buildFileUri(
  authority: 'storage' | 'sandbox',
  ...args: [path: string] | [sandboxId: string | null, path: string]
): string {
  if (authority === 'storage') {
    return `yaar://storage/${args[0]}`;
  }
  const [sandboxId, path] = args.length === 2 ? args : [null, args[0]];
  const id = sandboxId ?? 'new';
  return path ? `yaar://sandbox/${id}/${path}` : `yaar://sandbox/${id}`;
}

// ============ Window URIs ============

/**
 * Build a yaar:// window URI from monitor and window IDs.
 *   buildWindowUri('monitor-0', 'win-storage') → 'yaar://monitor-0/win-storage'
 */
export function buildWindowUri(monitorId: string, windowId: string): string {
  return `yaar://${monitorId}/${windowId}`;
}

/**
 * Parse a yaar:// window URI into monitor and window IDs.
 *   parseWindowUri('yaar://monitor-0/win-storage') → { monitorId: 'monitor-0', windowId: 'win-storage' }
 */
export function parseWindowUri(uri: string): { monitorId: string; windowId: string } | null {
  const match = uri.match(/^yaar:\/\/(monitor-[^/]+)\/(.+)$/);
  if (!match) return null;
  return { monitorId: match[1], windowId: match[2] };
}
