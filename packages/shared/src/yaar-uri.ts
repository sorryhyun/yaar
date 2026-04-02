/**
 * YAAR URI scheme — unified addressing for apps, storage, windows, and session resources.
 *
 * Format: yaar://{authority}/{path}
 *
 * Content resources:
 *   yaar://apps/{appId}                → app (resolved to iframe URL)
 *   yaar://storage/{path}              → persistent storage file
 *
 * Window addressing:
 *   yaar://windows/{windowId}                   → window (monitor inferred from context)
 *   yaar://windows/{windowId}/state/{key}       → window state (app-protocol)
 *   yaar://windows/{windowId}/commands/{key}    → window command (app-protocol)
 *
 * Session-scoped resources (yaar://session/...):
 *   yaar://session/agents/{id}              → agent by ID
 *   yaar://session/agents/{id}/interrupt     → agent action
 *   yaar://session/notifications/{id}        → notification by ID
 *   yaar://session/prompts                   → user prompts
 *   yaar://session/clipboard                 → clipboard
 *   yaar://session/monitors/{monitorId}      → monitor by ID
 */

export type YaarAuthority =
  | 'apps'
  | 'storage'
  | 'windows'
  | 'config'
  | 'browser'
  | 'session'
  | 'history'
  | 'skills'
  | 'mcp';

export interface ParsedYaarUri {
  authority: YaarAuthority;
  path: string;
}

const YAAR_RE = /^yaar:\/\/(apps|storage|windows|config|browser|session|history|skills|mcp)\/(.*)$/;

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
 *   yaar://apps/{appId}           → /api/apps/{appId}/dist/index.html
 *   yaar://apps/{appId}/{subpath} → /api/apps/{appId}/{subpath}
 *   yaar://storage/{path}         → /api/storage/{path}
 */
export function resolveContentUri(uri: string): string | null {
  const parsed = parseYaarUri(uri);
  if (!parsed) return null;
  switch (parsed.authority) {
    case 'apps': {
      const slashIdx = parsed.path.indexOf('/');
      if (slashIdx === -1) return `/api/apps/${parsed.path}/dist/index.html`;
      return `/api/apps/${parsed.path}`;
    }
    case 'storage':
      return `/api/storage/${parsed.path}`;
    case 'windows':
    case 'config':
    case 'browser':
    case 'session':
    case 'history':
    case 'skills':
    case 'mcp':
      // These authorities have no content resolution
      return null;
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

// ============ Brace Expansion ============

/**
 * Expand brace patterns in a yaar:// URI.
 *
 *   expandBraceUri('yaar://storage/{a.txt, b.txt}')
 *     → ['yaar://storage/a.txt', 'yaar://storage/b.txt']
 *
 *   expandBraceUri('yaar://storage/file.txt')
 *     → ['yaar://storage/file.txt']
 *
 * Only the first brace group is expanded. No nesting.
 */
export function expandBraceUri(uri: string): string[] {
  const match = uri.match(/^(.*)\{([^}]+)}(.*)$/);
  if (!match) return [uri];
  const [, prefix, inner, suffix] = match;
  const alternatives = inner.split(',');
  // Require at least 2 alternatives (single item in braces is not expansion)
  if (alternatives.length < 2) return [uri];
  return alternatives.map((alt) => `${prefix}${alt.trim()}${suffix}`);
}

// ============ File-operation URIs ============

export type ParsedFileUri = { authority: 'storage'; path: string };

/**
 * Parse a file-operation URI.
 *
 * Primary format: yaar://storage/{path}
 *
 *   yaar://storage/docs/file.txt      → { authority: 'storage', path: 'docs/file.txt' }
 *   yaar://storage/                   → { authority: 'storage', path: '' }
 *
 * Legacy forms (still accepted for backward compat):
 *   storage://docs/file.txt           → { authority: 'storage', path: 'docs/file.txt' }
 */
export function parseFileUri(uri: string): ParsedFileUri | null {
  // yaar:// scheme
  const parsed = parseYaarUri(uri);
  if (parsed) {
    if (parsed.authority === 'storage') {
      return { authority: 'storage', path: parsed.path };
    }
    return null; // non-file authority
  }

  // Legacy: storage://{path}
  const storageMatch = uri.match(/^storage:\/\/(.*)$/);
  if (storageMatch) {
    return { authority: 'storage', path: storageMatch[1] };
  }

  return null;
}

/**
 * Build a yaar:// file-operation URI.
 *
 *   buildFileUri('storage', 'docs/file.txt')       → 'yaar://storage/docs/file.txt'
 */
export function buildFileUri(_authority: 'storage', path: string): string {
  return `yaar://storage/${path}`;
}

// ============ Window URIs (yaar://windows/) ============

export interface ParsedBareWindowUri {
  windowId: string;
  subPath?: string;
}

/**
 * Parse a yaar://windows/{windowId} URI (monitor-less shortcut).
 *
 *   parseBareWindowUri('yaar://windows/my-win')            → { windowId: 'my-win' }
 *   parseBareWindowUri('yaar://windows/my-win/state/cells') → { windowId: 'my-win', subPath: 'state/cells' }
 *   parseBareWindowUri('yaar://windows/')                   → { windowId: '' } (monitor-level, for creates)
 */
export function parseBareWindowUri(uri: string): ParsedBareWindowUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'windows') return null;

  if (!parsed.path) return { windowId: '' }; // bare yaar://windows/ → monitor-level

  const slashIdx = parsed.path.indexOf('/');
  if (slashIdx === -1) return { windowId: parsed.path };

  return {
    windowId: parsed.path.slice(0, slashIdx),
    subPath: parsed.path.slice(slashIdx + 1) || undefined,
  };
}

/**
 * Whether this is a bare `yaar://windows/` URI (with or without a windowId).
 */
export function isBareWindowsAuthority(uri: string): boolean {
  const parsed = parseYaarUri(uri);
  return parsed?.authority === 'windows';
}
