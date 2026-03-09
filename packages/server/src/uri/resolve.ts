/**
 * Typed server-side resource resolution for yaar:// URIs.
 *
 * Resolves a yaar:// URI to an absolute filesystem path with metadata,
 * enabling the server to validate paths and determine access permissions.
 */

import { join } from 'path';
import {
  parseYaarUri,
  resolveContentUri,
  parseWindowUri,
  parseBareWindowUri,
  parseConfigUri,
  parseBrowserUri,
  parseSessionUri,
  type ParsedConfigUri,
  type ParsedBrowserUri,
  type SessionResource,
  type SessionSubKind,
} from '@yaar/shared';
import { safePath } from '../http/utils.js';
import { resolvePath } from '../storage/storage-manager.js';
import { PROJECT_ROOT } from '../config.js';
import { getMonitorId } from '../agents/session.js';

export type ResourceKind = 'app-static' | 'storage' | 'sandbox';

export interface ResolvedResource {
  kind: ResourceKind;
  absolutePath: string;
  readOnly: boolean;
  appId?: string;
  sandboxId?: string;
  sourceUri: string;
  /** API path for frontend consumption */
  apiPath: string;
}

export interface ResolvedWindow {
  kind: 'window';
  monitorId: string;
  windowId: string;
  subPath?: string;
  sourceUri: string;
}

export interface ResolvedConfig {
  kind: 'config';
  section: ParsedConfigUri['section'];
  id?: string;
  sourceUri: string;
}

export interface ResolvedBrowser {
  kind: 'browser';
  resource: ParsedBrowserUri['resource'];
  subResource?: ParsedBrowserUri['subResource'];
  sourceUri: string;
}

export interface ResolvedSession {
  kind: 'session';
  resource: SessionResource;
  subKind?: SessionSubKind;
  id?: string;
  action?: string;
  sourceUri: string;
}

export interface ResolvedRoot {
  kind: 'root';
  sourceUri: string;
}

export type ResolvedUri =
  | ResolvedRoot
  | ResolvedResource
  | ResolvedWindow
  | ResolvedConfig
  | ResolvedBrowser
  | ResolvedSession;

export function resolveResourceUri(uri: string): ResolvedResource | null {
  const parsed = parseYaarUri(uri);
  if (!parsed) return null;

  const apiPath = resolveContentUri(uri);
  if (!apiPath) return null;

  switch (parsed.authority) {
    case 'apps': {
      const slashIdx = parsed.path.indexOf('/');
      const appId = slashIdx === -1 ? parsed.path : parsed.path.slice(0, slashIdx);
      const subpath = slashIdx === -1 ? 'index.html' : parsed.path.slice(slashIdx + 1);
      const base = join(PROJECT_ROOT, 'apps', appId);
      const absolutePath = safePath(base, subpath);
      if (!absolutePath) return null;
      return {
        kind: 'app-static',
        absolutePath,
        readOnly: true,
        appId,
        sourceUri: uri,
        apiPath,
      };
    }

    case 'storage': {
      const resolved = resolvePath(parsed.path);
      if (!resolved) return null;
      return {
        kind: 'storage',
        absolutePath: resolved.absolutePath,
        readOnly: resolved.readOnly,
        sourceUri: uri,
        apiPath,
      };
    }

    case 'sandbox': {
      const slashIdx = parsed.path.indexOf('/');
      const sandboxId = slashIdx === -1 ? parsed.path : parsed.path.slice(0, slashIdx);
      const subpath = slashIdx === -1 ? '' : parsed.path.slice(slashIdx + 1);
      const base = join(PROJECT_ROOT, 'sandbox', sandboxId);
      const absolutePath = safePath(base, subpath || 'index.html');
      if (!absolutePath) return null;
      return {
        kind: 'sandbox',
        absolutePath,
        readOnly: false,
        sandboxId,
        sourceUri: uri,
        apiPath,
      };
    }

    case 'monitors':
    case 'windows':
    case 'config':
    case 'browser':
    case 'sessions':
      // Not content resources — handled by resolveUri via dedicated parsers
      return null;
  }
}

/**
 * Resolve any yaar:// URI — content resources (apps, storage, sandbox) or window addresses.
 * Window URIs use `yaar://windows/{windowId}` (preferred) or legacy `yaar://monitors/{m}/{w}`.
 */
export function resolveUri(uri: string): ResolvedUri | null {
  // Root URI: yaar://
  if (uri === 'yaar://') {
    return { kind: 'root', sourceUri: uri };
  }

  const resource = resolveResourceUri(uri);
  if (resource) return resource;

  const win = parseWindowUri(uri);
  if (win) {
    return {
      kind: 'window',
      monitorId: win.monitorId,
      windowId: win.windowId,
      subPath: win.subPath,
      sourceUri: uri,
    };
  }

  // yaar://windows/{windowId} — monitor-less shortcut, injects current monitorId
  const bareWin = parseBareWindowUri(uri);
  if (bareWin) {
    const monitorId = getMonitorId() ?? '0';
    if (bareWin.windowId) {
      return {
        kind: 'window',
        monitorId,
        windowId: bareWin.windowId,
        subPath: bareWin.subPath,
        sourceUri: uri,
      };
    }
    // yaar://windows/ with no windowId → treat as window collection
    return { kind: 'window', monitorId, windowId: '', sourceUri: uri };
  }

  const config = parseConfigUri(uri);
  if (config) {
    return {
      kind: 'config',
      section: config.section,
      id: config.id,
      sourceUri: uri,
    };
  }

  const browser = parseBrowserUri(uri);
  if (browser) {
    return {
      kind: 'browser',
      resource: browser.resource,
      subResource: browser.subResource,
      sourceUri: uri,
    };
  }

  const session = parseSessionUri(uri);
  if (session) {
    return {
      kind: 'session',
      resource: session.resource,
      subKind: session.subKind,
      id: session.id,
      action: session.action,
      sourceUri: uri,
    };
  }

  // Fallback: collection-level URIs like yaar://config/, yaar://browser/, etc.
  // These have a valid authority but no path segments for the individual parsers.
  const parsed = parseYaarUri(uri);
  if (parsed && !parsed.path) {
    return { kind: 'root', sourceUri: uri };
  }

  return null;
}
