/**
 * Server-only YAAR URI parsers.
 *
 * These utilities parse and build URIs for resources that only the server
 * needs to address (window resources, config, browser, sessions).
 * Shared-layer primitives (parseYaarUri, parseBareWindowUri)
 * are imported from @yaar/shared.
 */

import type { ParsedBareWindowUri } from '@yaar/shared';
import { parseYaarUri, parseBareWindowUri } from '@yaar/shared';

// ============ Content Path Parsing ============

export type ParsedContentPath =
  | { authority: 'storage'; path: string }
  | { authority: 'apps'; appId: string; path: string };

/** App IDs are kebab-case: starts with lowercase letter, then lowercase letters, digits, or hyphens. */
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse an API pathname back into a ParsedContentPath.
 * Reverse of resolveContentUri() for storage/apps paths.
 *
 *   /api/storage/docs/file.txt      -> { authority: 'storage', path: 'docs/file.txt' }
 *   /api/apps/dock/dist/index.html  -> { authority: 'apps', appId: 'dock', path: 'dist/index.html' }
 */
export function parseContentPath(pathname: string): ParsedContentPath | null {
  if (pathname.startsWith('/api/storage/')) {
    return { authority: 'storage', path: pathname.slice('/api/storage/'.length) };
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

// ============ Window Resource URIs ============

export interface ParsedWindowResourceUri {
  windowId: string;
  resourceType: 'state' | 'commands';
  key: string;
}

/**
 * Build a yaar:// window resource URI.
 *   buildWindowResourceUri('win-excel', 'state', 'cells') -> 'yaar://windows/win-excel/state/cells'
 */
export function buildWindowResourceUri(
  windowId: string,
  resourceType: 'state' | 'commands',
  key: string,
): string {
  return `yaar://windows/${windowId}/${resourceType}/${key}`;
}

/**
 * Parse a yaar:// window resource URI into its components.
 *   parseWindowResourceUri('yaar://windows/win-excel/state/cells')
 *     -> { windowId: 'win-excel', resourceType: 'state', key: 'cells' }
 */
export function parseWindowResourceUri(uri: string): ParsedWindowResourceUri | null {
  const bare: ParsedBareWindowUri | null = parseBareWindowUri(uri);
  if (!bare?.subPath) return null;
  return extractResourceFromSubPath(bare.windowId, bare.subPath);
}

function extractResourceFromSubPath(
  windowId: string,
  subPath: string,
): ParsedWindowResourceUri | null {
  const slashIdx = subPath.indexOf('/');
  if (slashIdx === -1) return null;
  const type = subPath.slice(0, slashIdx);
  if (type !== 'state' && type !== 'commands') return null;
  return {
    windowId,
    resourceType: type,
    key: subPath.slice(slashIdx + 1),
  };
}

// ============ Config URIs ============

export type ConfigSection =
  | 'settings'
  | 'hooks'
  | 'shortcuts'
  | 'mounts'
  | 'app'
  | 'domains'
  | 'mcp';

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
  'domains',
  'mcp',
]);

/**
 * Parse a yaar://config/... URI.
 *
 *   parseConfigUri('yaar://config/settings')      -> { section: 'settings' }
 *   parseConfigUri('yaar://config/hooks/hook-1')   -> { section: 'hooks', id: 'hook-1' }
 *   parseConfigUri('yaar://config/app/github')     -> { section: 'app', id: 'github' }
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
 *   buildConfigUri('settings')          -> 'yaar://config/settings'
 *   buildConfigUri('hooks', 'hook-1')   -> 'yaar://config/hooks/hook-1'
 *   buildConfigUri('app', 'github')     -> 'yaar://config/app/github'
 */
export function buildConfigUri(section: ConfigSection, id?: string): string {
  return id ? `yaar://config/${section}/${id}` : `yaar://config/${section}`;
}

// ============ Session URIs ============

export type SessionSubKind =
  | 'agents'
  | 'notifications'
  | 'prompts'
  | 'clipboard'
  | 'monitors'
  | 'logs'
  | 'context'
  | 'transcript'
  | 'messages';

export interface ParsedSessionUri {
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
  'transcript',
  'messages',
]);

/**
 * Parse a yaar://session/... URI with support for deep paths.
 *
 *   parseSessionUri('yaar://session/')
 *     -> { }
 *   parseSessionUri('yaar://session/agents')
 *     -> { subKind: 'agents' }
 *   parseSessionUri('yaar://session/agents/agent-123')
 *     -> { subKind: 'agents', id: 'agent-123' }
 *   parseSessionUri('yaar://session/agents/agent-123/interrupt')
 *     -> { subKind: 'agents', id: 'agent-123', action: 'interrupt' }
 *   parseSessionUri('yaar://session/notifications')
 *     -> { subKind: 'notifications' }
 *   parseSessionUri('yaar://session/notifications/abc')
 *     -> { subKind: 'notifications', id: 'abc' }
 *   parseSessionUri('yaar://session/prompts')
 *     -> { subKind: 'prompts' }
 *   parseSessionUri('yaar://session/clipboard')
 *     -> { subKind: 'clipboard' }
 *   parseSessionUri('yaar://session/monitors/0')
 *     -> { subKind: 'monitors', id: '0' }
 */
export function parseSessionUri(uri: string): ParsedSessionUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'session') return null;

  // Split path into segments: "agents/agent-123/interrupt" -> ["agents", "agent-123", "interrupt"]
  const segments = parsed.path.split('/').filter(Boolean);

  const result: ParsedSessionUri = {};

  if (segments.length >= 1) {
    if (!SESSION_SUB_KINDS.has(segments[0])) return null;
    result.subKind = segments[0] as SessionSubKind;
  }

  if (segments.length >= 2) {
    result.id = segments[1];
  }

  if (segments.length >= 3) {
    result.action = segments[2];
  }

  return result;
}

/**
 * Build a yaar://session/... URI.
 *
 *   buildSessionUri()                                    -> 'yaar://session/'
 *   buildSessionUri('agents')                            -> 'yaar://session/agents'
 *   buildSessionUri('agents', 'agent-123')               -> 'yaar://session/agents/agent-123'
 *   buildSessionUri('agents', 'agent-123', 'interrupt')  -> 'yaar://session/agents/agent-123/interrupt'
 *   buildSessionUri('notifications')                     -> 'yaar://session/notifications'
 *   buildSessionUri('monitors', '0')                     -> 'yaar://session/monitors/0'
 */
export function buildSessionUri(subKind?: SessionSubKind, id?: string, action?: string): string {
  let uri = 'yaar://session/';
  if (subKind) uri += subKind;
  if (id) uri += `/${id}`;
  if (action) uri += `/${action}`;
  return uri;
}

// ============ History URIs ============

export type HistorySubPath = 'transcript' | 'messages';

export interface ParsedHistoryUri {
  /** Session ID, or undefined for the root list. */
  sessionId?: string;
  /** Sub-resource within a session. */
  subPath?: HistorySubPath;
}

const HISTORY_SUB_PATHS: ReadonlySet<string> = new Set(['transcript', 'messages']);

/**
 * Parse a yaar://history/... URI.
 *
 *   parseHistoryUri('yaar://history/')
 *     -> { }
 *   parseHistoryUri('yaar://history/2025-01-01_12-00-00')
 *     -> { sessionId: '2025-01-01_12-00-00' }
 *   parseHistoryUri('yaar://history/2025-01-01_12-00-00/transcript')
 *     -> { sessionId: '2025-01-01_12-00-00', subPath: 'transcript' }
 *   parseHistoryUri('yaar://history/2025-01-01_12-00-00/messages')
 *     -> { sessionId: '2025-01-01_12-00-00', subPath: 'messages' }
 */
export function parseHistoryUri(uri: string): ParsedHistoryUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'history') return null;

  const segments = parsed.path.split('/').filter(Boolean);
  if (segments.length === 0) return {};

  const result: ParsedHistoryUri = { sessionId: segments[0] };

  if (segments.length >= 2) {
    if (!HISTORY_SUB_PATHS.has(segments[1])) return null;
    result.subPath = segments[1] as HistorySubPath;
  }

  return result;
}
