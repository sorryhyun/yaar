/**
 * Typed server-side resource resolution for yaar:// URIs.
 *
 * Resolves a yaar:// URI to an absolute filesystem path with metadata,
 * enabling the server to validate paths and determine access permissions.
 */

import { join } from 'path';
import { parseYaarUri, resolveContentUri } from '@yaar/shared';
import { safePath } from '../http/utils.js';
import { resolvePath } from '../storage/storage-manager.js';
import { PROJECT_ROOT } from '../config.js';

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
  }
}
