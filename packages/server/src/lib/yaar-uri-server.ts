/**
 * Server-only YAAR URI parsers.
 *
 * These utilities parse and build URIs for resources that only the server
 * needs to address (window resources, config, browser, sessions).
 * Shared-layer primitives (parseYaarUri, parseWindowUri, parseBareWindowUri)
 * are imported from @yaar/shared.
 */

import type { ParsedWindowUri, ParsedBareWindowUri } from '@yaar/shared';
import { parseYaarUri, parseWindowUri, parseBareWindowUri } from '@yaar/shared';

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
  monitorId: string;
  windowId: string;
  resourceType: 'state' | 'commands';
  key: string;
}

/**
 * Build a yaar:// window resource URI.
 *   buildWindowResourceUri('0', 'win-excel', 'state', 'cells') -> 'yaar://monitors/0/win-excel/state/cells'
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
 *     -> { monitorId: '0', windowId: 'win-excel', resourceType: 'state', key: 'cells' }
 *   parseWindowResourceUri('yaar://windows/win-excel/state/cells')
 *     -> { monitorId: '', windowId: 'win-excel', resourceType: 'state', key: 'cells' }
 */
export function parseWindowResourceUri(uri: string): ParsedWindowResourceUri | null {
  // Try yaar://monitors/{m}/{w}/{type}/{key}
  const parsed: ParsedWindowUri | null = parseWindowUri(uri);
  if (parsed?.subPath) {
    const result = extractResourceFromSubPath(parsed.monitorId, parsed.windowId, parsed.subPath);
    if (result) return result;
  }
  // Try yaar://windows/{w}/{type}/{key}
  const bare: ParsedBareWindowUri | null = parseBareWindowUri(uri);
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

export type ConfigSection = 'settings' | 'hooks' | 'shortcuts' | 'mounts' | 'app' | 'domains';

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
 *   parseBrowserUri('yaar://browser/0')            -> { resource: '0' }
 *   parseBrowserUri('yaar://browser/1/screenshot')  -> { resource: '1', subResource: 'screenshot' }
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
 *   buildBrowserUri('0')              -> 'yaar://browser/0'
 *   buildBrowserUri('1', 'screenshot') -> 'yaar://browser/1/screenshot'
 */
export function buildBrowserUri(resource: string, subResource?: string): string {
  return subResource ? `yaar://browser/${resource}/${subResource}` : `yaar://browser/${resource}`;
}

// ============ Session URIs ============

export type SessionResource = 'current' | (string & {});

export type SessionSubKind =
  | 'agents'
  | 'notifications'
  | 'prompts'
  | 'clipboard'
  | 'monitors'
  | 'logs'
  | 'context';

export interface ParsedSessionUri {
  resource: SessionResource;
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
 *     -> { resource: 'current' }
 *   parseSessionUri('yaar://sessions/current/agents')
 *     -> { resource: 'current', subKind: 'agents' }
 *   parseSessionUri('yaar://sessions/current/agents/agent-123')
 *     -> { resource: 'current', subKind: 'agents', id: 'agent-123' }
 *   parseSessionUri('yaar://sessions/current/agents/agent-123/interrupt')
 *     -> { resource: 'current', subKind: 'agents', id: 'agent-123', action: 'interrupt' }
 *   parseSessionUri('yaar://sessions/current/notifications')
 *     -> { resource: 'current', subKind: 'notifications' }
 *   parseSessionUri('yaar://sessions/current/notifications/abc')
 *     -> { resource: 'current', subKind: 'notifications', id: 'abc' }
 *   parseSessionUri('yaar://sessions/current/prompts')
 *     -> { resource: 'current', subKind: 'prompts' }
 *   parseSessionUri('yaar://sessions/current/clipboard')
 *     -> { resource: 'current', subKind: 'clipboard' }
 *   parseSessionUri('yaar://sessions/current/monitors/0')
 *     -> { resource: 'current', subKind: 'monitors', id: '0' }
 */
export function parseSessionUri(uri: string): ParsedSessionUri | null {
  const parsed = parseYaarUri(uri);
  if (!parsed || parsed.authority !== 'sessions') return null;

  // Split path into segments: "current/agents/agent-123/interrupt" -> ["current", "agents", "agent-123", "interrupt"]
  const segments = parsed.path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const resource = segments[0];
  const result: ParsedSessionUri = { resource };

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
 *   buildSessionUri('current')                                    -> 'yaar://sessions/current'
 *   buildSessionUri('current', 'agents')                          -> 'yaar://sessions/current/agents'
 *   buildSessionUri('current', 'agents', 'agent-123')             -> 'yaar://sessions/current/agents/agent-123'
 *   buildSessionUri('current', 'agents', 'agent-123', 'interrupt') -> 'yaar://sessions/current/agents/agent-123/interrupt'
 *   buildSessionUri('current', 'notifications')                   -> 'yaar://sessions/current/notifications'
 *   buildSessionUri('current', 'monitors', '0')                   -> 'yaar://sessions/current/monitors/0'
 */
export function buildSessionUri(
  resource: SessionResource,
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
