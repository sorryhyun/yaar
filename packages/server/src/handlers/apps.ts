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
  okWithImages,
  error,
  validateRelativePath,
  extractIdFromUri,
} from './utils.js';
import { resolvePath } from '../storage/storage-manager.js';
import { actionEmitter } from '../session/action-emitter.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { listApps, loadAppSkill } from '../features/apps/discovery.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
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
      return okJson(
        apps.map((app) => ({
          id: app.id,
          name: app.name,
          description: app.description,
          icon: app.icon,
          hasSkill: app.hasSkill,
          hasConfig: app.hasConfig,
          appProtocol: app.appProtocol,
          createShortcut: app.createShortcut,
        })),
      );
    },
  };
  registry.register('yaar://apps', listHandler);

  // ── yaar://apps/{appId} — per-app operations + app-scoped storage ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app. Read to load its SKILL.md, invoke to set_badge, delete to uninstall. ' +
      'Sub-path /storage/{path} provides app-scoped file storage.',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['set_badge', 'write', 'clone'],
          description: 'set_badge for app badge, write for app storage, clone for source cloning',
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

      const apps = await listApps();
      const app = apps.find((a) => a.id === appId);
      if (!app) return error(`App "${appId}" not found.`);

      const invokeActions: Record<string, string> = {
        set_badge: 'Set badge count on app icon ({ count })',
      };

      // Build rich describe result
      const result: Record<string, unknown> = {
        uri: resolved.sourceUri,
        name: app.name,
        description: app.description,
        icon: app.icon,
        verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
        invokeActions,
      };

      if (app.appProtocol) result.appProtocol = true;
      if (app.protocol) result.protocol = app.protocol;
      if (app.permissions?.length) result.permissions = app.permissions;

      // Append SKILL.md content
      const skill = await loadAppSkill(appId);
      if (skill) result.skill = skill;

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
          return okJson(listResult.entries ?? []);
        }
        const result = await storageRead(prefixedPath, { raw: true });
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
        // Text content — raw (no line numbers)
        return ok(result.content!);
      }

      // ── App skill (existing behavior) ──
      const appId = extractIdFromUri(resolved.sourceUri, 'apps');
      if (!appId) return error('App ID required.');

      const skill = await loadAppSkill(appId);
      if (skill === null) return error(`No SKILL.md found for app "${appId}".`);

      // Build up result starting with skill content
      let result = skill;

      // Append static protocol manifest if available
      const apps = await listApps();
      const app = apps.find((a) => a.id === appId);
      if (app?.protocol) {
        const sections: string[] = [];
        const { state, commands } = app.protocol;
        if (state && Object.keys(state).length) {
          sections.push(
            '### State\n' +
              Object.entries(state)
                .map(([k, v]) => `- \`${k}\` — ${v.description}`)
                .join('\n'),
          );
        }
        if (commands && Object.keys(commands).length) {
          sections.push(
            '### Commands\n' +
              Object.entries(commands)
                .map(([k, v]) => `- \`${k}\` — ${v.description}`)
                .join('\n'),
          );
        }
        if (sections.length) {
          result += '\n\n## Protocol\n\n' + sections.join('\n\n');
        }
      }

      // Append permissions section if the app declares URI permissions
      if (app?.permissions?.length) {
        const permissionsList = app.permissions
          .map((p) => {
            if (typeof p === 'string') return `- \`${p}\``;
            const verbs = p.verbs?.length ? ` (${p.verbs.join(', ')})` : '';
            return `- \`${p.uri}\`${verbs}`;
          })
          .join('\n');
        result += '\n\n## Permissions\n\n' + permissionsList;
      }

      return ok(result);
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      // ── App storage sub-path ──
      const storagePath = parseAppStoragePath(resolved.sourceUri);
      if (storagePath) {
        const prefixedPath = `apps/${storagePath.appId}/${storagePath.path}`;
        const result = await storageList(prefixedPath);
        if (!result.success) return error(result.error!);
        // Return JSON entries for machine-readable consumption
        const entries = (result.entries ?? []).map((e) => ({
          // Strip the apps/{appId}/ prefix from paths for app-relative paths
          path: e.path.replace(`apps/${storagePath.appId}/`, ''),
          isDirectory: e.isDirectory,
          size: e.size,
          modifiedAt: e.modifiedAt,
        }));
        return okJson(entries);
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
        if (!storagePath.path) return error('Provide a file path under /storage/.');
        if (!payload?.action) return error('Payload must include "action" ("write").');
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

export { installApp } from '../features/apps/install.js';
