/**
 * Apps domain handlers for the verb layer.
 *
 * Maps app operations to the verb layer:
 *
 *   list('yaar://apps')                              → list all installed apps
 *   read('yaar://apps/{appId}')                      → load SKILL.md
 *   invoke('yaar://apps/{appId}', { action, ... })   → set_badge
 *   delete('yaar://apps/{appId}')                    → uninstall app
 *
 * App-scoped storage (Phase 2):
 *   read('yaar://apps/{appId}/storage/{path}')       → read file
 *   list('yaar://apps/{appId}/storage/{dir}')        → list directory
 *   invoke('yaar://apps/{appId}/storage/{path}', ..) → write file
 *   delete('yaar://apps/{appId}/storage/{path}')     → delete file
 *
 * On disk: storage/apps/{appId}/{path}
 */

import type { OSAction } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import {
  ok,
  okJson,
  okResource,
  okLinks,
  okWithImages,
  error,
  validateRelativePath,
  extractIdFromUri,
  mimeFromPath,
} from './utils.js';
import { resolvePath } from '../storage/storage-manager.js';
import { actionEmitter } from '../session/action-emitter.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { listApps } from '../features/apps/discovery.js';
import { describeApp, loadAppSkillWithManifest } from '../features/apps/describe.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../storage/storage-manager.js';
import { uninstallApp } from '../features/apps/install.js';

/**
 * Parse `yaar://apps/{appId}/storage/{path}` → { appId, path } or null.
 * Rejects paths containing `..` segments to prevent cross-app traversal.
 */
function parseAppStoragePath(uri: string): { appId: string; path: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/storage(?:\/(.*))?$/);
  if (!match) return null;
  const path = match[2] ?? '';
  // Block path traversal — apps must stay within their own namespace
  if (validateRelativePath(path)) return null;
  return { appId: match[1], path };
}

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all installed apps (exact match) ──
  const listHandler: ResourceHandler = {
    description: 'List all installed apps.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const apps = await listApps();
      return okLinks(
        apps.map((app) => ({
          uri: `yaar://apps/${app.id}`,
          name: app.name,
          description: app.description,
        })),
      );
    },
  };
  registry.register('yaar://apps', listHandler);

  // ── yaar://apps/{appId} — per-app operations + app-scoped storage ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app. Read to load its SKILL.md, invoke to set_badge/install, delete to uninstall. ' +
      'Sub-path /storage/{path} provides app-scoped file storage.',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['set_badge', 'install', 'write', 'clone'],
          description:
            'set_badge for app badge, install from marketplace, write for app storage, clone for source cloning',
        },
        count: { type: 'number', description: 'Badge count (0 to clear, for set_badge)' },
        content: { type: 'string', description: 'File content (for write)' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Content encoding (default: utf-8)',
        },
      },
    },

    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      // Storage sub-paths get generic describe
      if (parseAppStoragePath(resolved.sourceUri)) {
        return okJson({
          uri: resolved.sourceUri,
          description: 'App-scoped file storage.',
          verbs: ['read', 'list', 'invoke', 'delete'],
        });
      }

      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');

      const result = await describeApp(appId);
      if (!result) return error(`App "${appId}" not found.`);

      result.uri = resolved.sourceUri;
      return okJson(result);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        if (!storagePath.path) {
          // Bare storage root → redirect to list
          const listResult = await storageList(prefixedPath);
          if (!listResult.success) return error(listResult.error!);
          const readEntries = listResult.entries ?? [];
          return okLinks(
            readEntries.map((e) => ({
              uri: `yaar://apps/${storagePath.appId}/storage/${e.path.replace(`apps/${storagePath.appId}/`, '')}`,
              name: e.path.split('/').pop() || e.path,
              description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
              mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
            })),
          );
        }
        const result = await storageRead(prefixedPath);
        if (!result.success) return error(result.error!);
        // Images / PDFs — return base64 content items
        if (result.images?.length) {
          return okWithImages(result.content!, result.images);
        }
        // Unknown binary — read raw bytes and return as base64
        if (result.content?.startsWith('Binary file')) {
          const resolvedFile = resolvePath(prefixedPath);
          if (resolvedFile) {
            const buf = Buffer.from(await Bun.file(resolvedFile.absolutePath).arrayBuffer());
            return okWithImages('', [
              { data: buf.toString('base64'), mimeType: 'application/octet-stream' },
            ]);
          }
        }
        // Text content — return as embedded resource with URI + MIME
        return okResource(resolved.sourceUri, result.content!, mimeFromPath(storagePath.path));
      }

      // ── App skill (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');

      const result = await loadAppSkillWithManifest(appId);
      if (result === null) return error(`No SKILL.md found for app "${appId}".`);

      return okResource(resolved.sourceUri, result, 'text/markdown');
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const result = await storageList(prefixedPath);
        if (!result.success) return error(result.error!);
        const entries = result.entries ?? [];
        return okLinks(
          entries.map((e) => {
            const relPath = e.path.replace(`apps/${storagePath.appId}/`, '');
            return {
              uri: `yaar://apps/${storagePath.appId}/storage/${relPath}`,
              name: relPath.split('/').pop() || relPath,
              description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
              mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
            };
          }),
        );
      }

      // Non-storage list on a specific app doesn't make sense
      return error(
        'Cannot list an app directly. Use list("yaar://apps") for all apps, ' +
          'or list("yaar://apps/{appId}/storage/") for app storage.',
      );
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        if (!payload?.action) return error('Payload must include "action".');

        if (payload.action === 'grep') {
          if (typeof payload.pattern !== 'string')
            return error('"pattern" (string) is required for grep.');
          const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
          const result = await storageGrep(
            prefixedPath,
            payload.pattern,
            payload.glob as string | undefined,
          );
          if (!result.success) return error(result.error!);
          return okJson({ matches: result.matches, truncated: result.truncated });
        }

        if (!storagePath.path) return error('Provide a file path under /storage/.');
        if (payload.action !== 'write') return error(`Unknown storage action "${payload.action}".`);
        if (typeof payload.content !== 'string')
          return error('"content" (string) is required for write.');

        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const content =
          payload.encoding === 'base64' ? Buffer.from(payload.content, 'base64') : payload.content;
        const result = await storageWrite(prefixedPath, content);
        if (!result.success) return error(result.error!);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return ok(`Written to yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
      }

      // ── App operations (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'set_badge') {
        const count = (payload.count as number) ?? 0;
        const osAction: OSAction = { type: 'app.badge', appId, count };
        actionEmitter.emitAction(osAction);
        return ok(
          count > 0 ? `Badge set to ${count} on "${appId}"` : `Badge cleared on "${appId}"`,
        );
      }

      if (payload.action === 'install') {
        const { installApp } = await import('../features/apps/install.js');
        return installApp(appId);
      }

      if (payload.action === 'clone') {
        const { cloneAppSource } = await import('../features/dev/clone.js');
        const result = await cloneAppSource(appId);
        if (!result.success) return error(result.error!);
        return okJson({ files: result.files, meta: result.meta });
      }

      return error(`Unknown action "${payload.action}".`);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        if (!storagePath.path) return error('Provide a file path to delete.');
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const result = await storageDelete(prefixedPath);
        if (!result.success) return error(result.error!);
        subscriptionRegistry.notifyChange(resolved.sourceUri);
        return ok(`Deleted yaar://apps/${storagePath.appId}/storage/${storagePath.path}`);
      }

      // ── App uninstall (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');
      return uninstallApp(appId);
    },
  });
}
