/**
 * YAAR URI scheme — unified addressing for apps, storage, sandbox, monitors, and window resources.
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
 *   yaar://monitors/{monitorId}/{windowId}      → window on a monitor
 *
 * Session-scoped resources (consolidated under yaar://sessions/current/...):
 *   yaar://sessions/current/agents/{id}              → agent by ID
 *   yaar://sessions/current/agents/{id}/interrupt     → agent action
 *   yaar://sessions/current/notifications/{id}        → notification by ID
 *   yaar://sessions/current/prompts                   → user prompts
 *   yaar://sessions/current/clipboard                 → clipboard
 *   yaar://sessions/current/monitors/{monitorId}      → monitor by ID
 */

export type YaarAuthority =
  | 'apps'
  | 'storage'
  | 'sandbox'
  | 'monitors'
  | 'windows'
  | 'config'
  | 'browser'
  | 'sessions'
  | 'skills'
  | 'market';

export interface ParsedYaarUri {
  authority: YaarAuthority;
  path: string;
}

const YAAR_RE =
  /^yaar:\/\/(apps|storage|sandbox|monitors|windows|config|browser|sessions|skills|market)\/(.*)$/;

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
    case 'monitors':
    case 'windows':
    case 'config':
    case 'browser':
    case 'sessions':
    case 'skills':
    case 'market':
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

// ============ File-operation URIs ============

/** Reserved sandbox path segment for new sandbox creation. */
const SANDBOX_NEW = 'new';

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
 * Parse a file-operation URI.
 *
 * Primary format: yaar://storage/{path}, yaar://sandbox/{id}/{path}, yaar://sandbox/new/{path}
 * "new" is reserved for new sandbox creation; any other non-empty string is a valid sandbox ID.
 *
 *   yaar://storage/docs/file.txt      → { authority: 'storage', path: 'docs/file.txt' }
 *   yaar://storage/                   → { authority: 'storage', path: '' }
 *   yaar://sandbox/123/src/main.ts    → { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }
 *   yaar://sandbox/new/src/main.ts    → { authority: 'sandbox', sandboxId: null, path: 'src/main.ts' }
 *
 * Legacy forms (still accepted for backward compat):
 *   storage://docs/file.txt           → { authority: 'storage', path: 'docs/file.txt' }
 *   sandbox://123/src/main.ts         → { authority: 'sandbox', sandboxId: '123', ... }
 *   sandbox:///src/main.ts            → { authority: 'sandbox', sandboxId: null, ... }
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
        if (parsed.path === SANDBOX_NEW) return { authority: 'sandbox', sandboxId: null, path: '' };
        if (!parsed.path) return null;
        return { authority: 'sandbox', sandboxId: parsed.path, path: '' };
      }
      const first = parsed.path.slice(0, slashIdx);
      const rest = parsed.path.slice(slashIdx + 1);
      if (first === SANDBOX_NEW) {
        return { authority: 'sandbox', sandboxId: null, path: rest };
      }
      if (!first) return null;
      return { authority: 'sandbox', sandboxId: first, path: rest };
    }
    return null; // non-file authority
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
      if (!rest) return null;
      return { authority: 'sandbox', sandboxId: rest, path: '' };
    }
    const id = rest.slice(0, slashIdx);
    if (!id) return null;
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
      if (!rest) return null;
      return { authority: 'sandbox', sandboxId: rest, path: '' };
    }
    const id = rest.slice(0, slashIdx);
    if (!id) return null;
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

// ============ Window Keys ============

export interface ParsedWindowKey {
  monitorId: string;
  windowId: string;
}

/**
 * Build a scoped window key from monitorId and windowId.
 *   buildWindowKey('0', 'win-storage') → '0/win-storage'
 */
export function buildWindowKey(monitorId: string, windowId: string): string {
  return `${monitorId}/${windowId}`;
}

/**
 * Parse a scoped window key into monitorId and windowId.
 *   parseWindowKey('0/win-storage') → { monitorId: '0', windowId: 'win-storage' }
 */
export function parseWindowKey(key: string): ParsedWindowKey | null {
  const slashIdx = key.indexOf('/');
  if (slashIdx === -1) return null;
  return {
    monitorId: key.slice(0, slashIdx),
    windowId: key.slice(slashIdx + 1),
  };
}

// ============ Window URIs ============

/**
 * Build a yaar:// window URI from monitor and window IDs.
 *   buildWindowUri('0', 'win-storage') → 'yaar://monitors/0/win-storage'
 */
export function buildWindowUri(monitorId: string, windowId: string): string {
  return `yaar://monitors/${monitorId}/${windowId}`;
}

export interface ParsedWindowUri {
  monitorId: string;
  windowId: string;
  subPath?: string;
}

/**
 * Parse a yaar:// window URI into monitor and window IDs, with optional sub-path.
 *   parseWindowUri('yaar://monitors/0/win-storage') → { monitorId: '0', windowId: 'win-storage' }
 *   parseWindowUri('yaar://monitors/0/win-excel/state/cells') → { monitorId: '0', windowId: 'win-excel', subPath: 'state/cells' }
 */
export function parseWindowUri(uri: string): ParsedWindowUri | null {
  const match = uri.match(/^yaar:\/\/monitors\/([^/]+)\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  return {
    monitorId: match[1],
    windowId: match[2],
    subPath: match[3] || undefined,
  };
}

// ============ Bare Window URIs (yaar://windows/) ============

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

// ============ Window Resource URIs ============

export interface ParsedWindowResourceUri {
  monitorId: string;
  windowId: string;
  resourceType: 'state' | 'commands';
  key: string;
}

/**
 * Build a yaar:// window resource URI.
 *   buildWindowResourceUri('0', 'win-excel', 'state', 'cells') → 'yaar://monitors/0/win-excel/state/cells'
 */
export function buildWindowResourceUri(
  monitorId: string,
  windowId: string,
  resourceType: 'state' | 'commands',
  key: string,
): string {
  return `yaar://monitors/${monitorId}/${windowId}/${resourceType}/${key}`;
}

/**
 * Parse a yaar:// window resource URI into its components.
 *   parseWindowResourceUri('yaar://monitors/0/win-excel/state/cells')
 *     → { monitorId: '0', windowId: 'win-excel', resourceType: 'state', key: 'cells' }
 *   parseWindowResourceUri('yaar://windows/win-excel/state/cells')
 *     → { monitorId: '', windowId: 'win-excel', resourceType: 'state', key: 'cells' }
 */
export function parseWindowResourceUri(uri: string): ParsedWindowResourceUri | null {
  // Try yaar://monitors/{m}/{w}/{type}/{key}
  const parsed = parseWindowUri(uri);
  if (parsed?.subPath) {
    const result = extractResourceFromSubPath(parsed.monitorId, parsed.windowId, parsed.subPath);
    if (result) return result;
  }
  // Try yaar://windows/{w}/{type}/{key}
  const bare = parseBareWindowUri(uri);
  if (bare?.subPath) {
    const result = extractResourceFromSubPath('', bare.windowId, bare.subPath);
    if (result) return result;
  }
  return null;
}

function extractResourceFromSubPath(
  monitorId: string,
  windowId: string,
  subPath: string,
): ParsedWindowResourceUri | null {
  const slashIdx = subPath.indexOf('/');
  if (slashIdx === -1) return null;
  const type = subPath.slice(0, slashIdx);
  if (type !== 'state' && type !== 'commands') return null;
  return {
    monitorId,
    windowId,
    resourceType: type,
    key: subPath.slice(slashIdx + 1),
  };
}

// ============ Config URIs ============

export type ConfigSection = 'settings' | 'hooks' | 'shortcuts' | 'mounts' | 'app';

export interface ParsedConfigUri {
  section: ConfigSection;
  /** Entry ID within the section (e.g., hook ID, shortcut ID, app ID). */
  id?: string;
}

const CONFIG_SECTIONS: ReadonlySet<string> = new Set([
  'settings',
  'hooks',
  'shortcuts',
  'mounts',
  'app',
]);

/**
 * Parse a yaar://config/... URI.
 *
 *   parseConfigUri('yaar://config/settings')      → { section: 'settings' }
 *   parseConfigUri('yaar://config/hooks/hook-1')   → { section: 'hooks', id: 'hook-1' }
 *   parseConfigUri('yaar://config/app/github')     → { section: 'app', id: 'github' }
 */
export function parseConfigUri(uri: string): ParsedConfigUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'config') return null;

  const slashIdx = parsed.path.indexOf('/');
  const section = slashIdx === -1 ? parsed.path : parsed.path.slice(0, slashIdx);
  if (!CONFIG_SECTIONS.has(section)) return null;

  const id = slashIdx === -1 ? undefined : parsed.path.slice(slashIdx + 1);
  return { section: section as ConfigSection, id: id || undefined };
}

/**
 * Build a yaar://config/... URI.
 *
 *   buildConfigUri('settings')          → 'yaar://config/settings'
 *   buildConfigUri('hooks', 'hook-1')   → 'yaar://config/hooks/hook-1'
 *   buildConfigUri('app', 'github')     → 'yaar://config/app/github'
 */
export function buildConfigUri(section: ConfigSection, id?: string): string {
  return id ? `yaar://config/${section}/${id}` : `yaar://config/${section}`;
}

// ============ Browser URIs ============

export interface ParsedBrowserUri {
  /** Browser ID (numeric string, e.g. '0', '1'). */
  resource: string;
  /** Sub-resource (e.g., 'content', 'screenshot', 'navigate', 'click'). */
  subResource?: string;
}

/**
 * Parse a yaar://browser/... URI.
 *
 *   parseBrowserUri('yaar://browser/0')            → { resource: '0' }
 *   parseBrowserUri('yaar://browser/1/screenshot')  → { resource: '1', subResource: 'screenshot' }
 */
export function parseBrowserUri(uri: string): ParsedBrowserUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'browser') return null;

  const slashIdx = parsed.path.indexOf('/');
  const resource = slashIdx === -1 ? parsed.path : parsed.path.slice(0, slashIdx);
  if (!resource) return null;

  if (slashIdx === -1) return { resource };

  const sub = parsed.path.slice(slashIdx + 1);
  if (!sub) return null;
  return { resource, subResource: sub };
}

/**
 * Build a yaar://browser/... URI.
 *
 *   buildBrowserUri('0')              → 'yaar://browser/0'
 *   buildBrowserUri('1', 'screenshot') → 'yaar://browser/1/screenshot'
 */
export function buildBrowserUri(resource: string, subResource?: string): string {
  return subResource ? `yaar://browser/${resource}/${subResource}` : `yaar://browser/${resource}`;
}

// ============ Session URIs ============

export type SessionResource = 'current';

export type SessionSubKind =
  | 'agents'
  | 'notifications'
  | 'prompts'
  | 'clipboard'
  | 'monitors'
  | 'logs'
  | 'context';

export interface ParsedSessionUri {
  resource: 'current';
  subKind?: SessionSubKind;
  id?: string;
  action?: string;
}

const SESSION_SUB_KINDS: ReadonlySet<string> = new Set([
  'agents',
  'notifications',
  'prompts',
  'clipboard',
  'monitors',
  'logs',
  'context',
]);

/**
 * Parse a yaar://sessions/... URI with support for deep paths.
 *
 *   parseSessionUri('yaar://sessions/current')
 *     → { resource: 'current' }
 *   parseSessionUri('yaar://sessions/current/agents')
 *     → { resource: 'current', subKind: 'agents' }
 *   parseSessionUri('yaar://sessions/current/agents/agent-123')
 *     → { resource: 'current', subKind: 'agents', id: 'agent-123' }
 *   parseSessionUri('yaar://sessions/current/agents/agent-123/interrupt')
 *     → { resource: 'current', subKind: 'agents', id: 'agent-123', action: 'interrupt' }
 *   parseSessionUri('yaar://sessions/current/notifications')
 *     → { resource: 'current', subKind: 'notifications' }
 *   parseSessionUri('yaar://sessions/current/notifications/abc')
 *     → { resource: 'current', subKind: 'notifications', id: 'abc' }
 *   parseSessionUri('yaar://sessions/current/prompts')
 *     → { resource: 'current', subKind: 'prompts' }
 *   parseSessionUri('yaar://sessions/current/clipboard')
 *     → { resource: 'current', subKind: 'clipboard' }
 *   parseSessionUri('yaar://sessions/current/monitors/0')
 *     → { resource: 'current', subKind: 'monitors', id: '0' }
 */
export function parseSessionUri(uri: string): ParsedSessionUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'sessions') return null;

  // Split path into segments: "current/agents/agent-123/interrupt" → ["current", "agents", "agent-123", "interrupt"]
  const segments = parsed.path.split('/').filter(Boolean);
  if (segments.length === 0 || segments[0] !== 'current') return null;

  const result: ParsedSessionUri = { resource: 'current' };

  if (segments.length >= 2) {
    if (!SESSION_SUB_KINDS.has(segments[1])) return null;
    result.subKind = segments[1] as SessionSubKind;
  }

  if (segments.length >= 3) {
    result.id = segments[2];
  }

  if (segments.length >= 4) {
    result.action = segments[3];
  }

  return result;
}

/**
 * Build a yaar://sessions/... URI.
 *
 *   buildSessionUri('current')                                    → 'yaar://sessions/current'
 *   buildSessionUri('current', 'agents')                          → 'yaar://sessions/current/agents'
 *   buildSessionUri('current', 'agents', 'agent-123')             → 'yaar://sessions/current/agents/agent-123'
 *   buildSessionUri('current', 'agents', 'agent-123', 'interrupt') → 'yaar://sessions/current/agents/agent-123/interrupt'
 *   buildSessionUri('current', 'notifications')                   → 'yaar://sessions/current/notifications'
 *   buildSessionUri('current', 'monitors', '0')                   → 'yaar://sessions/current/monitors/0'
 */
export function buildSessionUri(
  resource: 'current',
  subKind?: SessionSubKind,
  id?: string,
  action?: string,
): string {
  let uri = `yaar://sessions/${resource}`;
  if (subKind) uri += `/${subKind}`;
  if (id) uri += `/${id}`;
  if (action) uri += `/${action}`;
  return uri;
}
