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

import { stat } from 'fs/promises';
import { join } from 'path';
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
import { PROJECT_ROOT } from '../config.js';

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
          enum: ['set_badge', 'write'],
          description: 'set_badge for app badge, write for app storage',
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

      // ── Server actions (app-specific invoke actions declared in app.json) ──
      const apps = await listApps();
      const appInfo = apps.find((a) => a.id === appId);
      const actionName = payload.action as string;
      if (appInfo?.serverActions?.[actionName]) {
        return handleServerAction(appId, actionName, payload);
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

/** Handle app-specific server actions declared in app.json serverActions. */
async function handleServerAction(
  appId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const projectId = payload.projectId as string;
  if (!projectId) return error('"projectId" is required.');

  // Validate projectId (prevent path traversal)
  if (projectId.includes('..') || projectId.includes('/')) {
    return error('Invalid projectId.');
  }

  const projectPath = join(PROJECT_ROOT, 'storage', 'apps', appId, 'projects', projectId);
  try {
    await stat(projectPath);
  } catch {
    return error(`Project "${projectId}" not found.`);
  }

  switch (action) {
    case 'compile': {
      const { compileTypeScript } = await import('../lib/compiler/index.js');
      const result = await compileTypeScript(projectPath, {
        title: (payload.title as string) ?? 'App',
      });
      if (!result.success) {
        return error(`Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`);
      }
      return okJson({
        success: true,
        previewUrl: `/api/storage/apps/${appId}/projects/${projectId}/dist/index.html`,
      });
    }
    case 'typecheck': {
      const { typecheckSandbox } = await import('../lib/compiler/index.js');
      const result = await typecheckSandbox(projectPath);
      if (!result.success) {
        return error(`Type check errors:\n${result.diagnostics.join('\n')}`);
      }
      return okJson({ success: true, diagnostics: result.diagnostics });
    }
    case 'deploy': {
      const { doDeploy } = await import('../features/dev/deploy.js');
      const deployAppId = payload.appId as string;
      if (!deployAppId) return error('"appId" is required for deploy.');
      const result = await doDeploy(projectId, {
        sourcePath: projectPath,
        appId: deployAppId,
        name: payload.name as string | undefined,
        description: payload.description as string | undefined,
        icon: payload.icon as string | undefined,
        permissions: payload.permissions as string[] | undefined,
      });
      if (!result.success) return error(result.error);
      return okJson({
        success: true,
        appId: result.appId,
        name: result.name,
        icon: result.icon,
      });
    }
    default:
      return error(`Unknown server action "${action}".`);
  }
}

export { installApp } from '../features/apps/install.js';
