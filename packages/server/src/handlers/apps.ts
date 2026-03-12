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

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink } from 'fs/promises';
import type { OSAction } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error } from './utils.js';
import { actionEmitter } from '../session/action-emitter.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { listApps, loadAppSkill } from '../features/apps/discovery.js';
import { PROJECT_ROOT } from '../config.js';
import {
  getConfigDir,
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../storage/shortcuts.js';

const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

function extractAppIdFromUri(uri: string): string {
  // yaar://apps/{appId} → appId
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)/);
  return match?.[1] ?? '';
}

/**
 * Parse `yaar://apps/{appId}/storage/{path}` → { appId, path } or null.
 * Rejects paths containing `..` segments to prevent cross-app traversal.
 */
function parseAppStoragePath(uri: string): { appId: string; path: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/storage(?:\/(.*))?$/);
  if (!match) return null;
  const path = match[2] ?? '';
  // Block path traversal — apps must stay within their own namespace
  if (path.split('/').includes('..')) return null;
  return { appId: match[1], path };
}

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all installed apps (exact match) ──
  const listHandler: ResourceHandler = {
    description: 'List all installed apps.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const apps = await listApps();
      if (apps.length === 0) return ok('No apps found in apps/ directory.');

      const lines = apps.map((app) => {
        const flags = [];
        if (app.hasSkill) flags.push('skill');
        if (app.hasConfig) flags.push('config');
        if (app.appProtocol) flags.push('app-protocol');
        if (app.createShortcut === false) flags.push('no-shortcut');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        let line = `- ${app.name} (${app.id})${flagStr}`;
        if (app.description) line += `\n  ${app.description}`;
        return line;
      });

      return ok(`Available apps:\n${lines.join('\n')}`);
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
          return ok(JSON.stringify(listResult.entries ?? []));
        }
        const result = await storageRead(prefixedPath);
        if (!result.success) return error(result.error!);
        // Return raw content for app consumption (strip line numbers)
        // storageRead adds "── path (N lines) ──\n" header + "N│" line numbers for text
        // Extract raw content by checking if it has the header pattern
        const content = result.content!;
        const headerEnd = content.indexOf('\n');
        if (headerEnd !== -1 && content.startsWith('── ')) {
          // Text file with line numbers — strip them
          const lines = content.slice(headerEnd + 1).split('\n');
          const raw = lines.map((line) => {
            const pipeIdx = line.indexOf('│');
            return pipeIdx !== -1 ? line.slice(pipeIdx + 1) : line;
          });
          return ok(raw.join('\n'));
        }
        return ok(content);
      }

      // ── App skill (existing behavior) ──
      const appId = extractAppIdFromUri(resolved.sourceUri);
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
        const permissionsList = app.permissions.map((p) => `- \`${p}\``).join('\n');
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
        return ok(JSON.stringify(entries));
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
      const appId = extractAppIdFromUri(resolved.sourceUri);
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
      const appId = extractAppIdFromUri(resolved.sourceUri);
      if (!appId) return error('App ID required.');
      return uninstallApp(appId);
    },
  });
}

export async function installApp(appId: string): Promise<VerbResult> {
  const appsDir = join(PROJECT_ROOT, 'apps');
  const appDir = join(appsDir, appId);
  const isUpdate = existsSync(appDir);

  const res = await fetch(`${MARKET_URL}/api/apps/${appId}/download`);
  if (!res.ok) {
    if (res.status === 404) return error(`App "${appId}" not found in the marketplace.`);
    return error(`Failed to download app (${res.status})`);
  }

  const { mkdir } = await import('fs/promises');
  const tmpDir = join(PROJECT_ROOT, 'storage', '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${appId}.tar.gz`);

  const buffer = Buffer.from(await res.arrayBuffer());
  await Bun.write(tmpFile, buffer);

  await mkdir(appDir, { recursive: true });
  try {
    const tarProc = Bun.spawnSync(['tar', 'xzf', tmpFile, '--strip-components=1', '-C', appDir]);
    if (tarProc.exitCode !== 0) {
      throw new Error(
        tarProc.stderr.toString().trim() || `tar exited with code ${tarProc.exitCode}`,
      );
    }
  } catch (err: unknown) {
    return error(
      `Failed to extract app archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }

  actionEmitter.emitAction({ type: 'desktop.refreshApps' });

  const apps = await listApps();
  const installed = apps.find((a) => a.id === appId);
  if (installed && installed.createShortcut !== false) {
    const shortcut = await ensureAppShortcut({
      id: installed.id,
      name: installed.name,
      icon: installed.icon,
      iconType: installed.iconType,
    });
    actionEmitter.emitAction({ type: 'desktop.createShortcut', shortcut });
  }

  return ok(`${isUpdate ? 'Updated' : 'Installed'} app "${appId}" successfully.`);
}

async function uninstallApp(appId: string): Promise<VerbResult> {
  const appDir = join(PROJECT_ROOT, 'apps', appId);
  if (!existsSync(appDir)) return error(`App "${appId}" is not installed.`);

  await rm(appDir, { recursive: true, force: true });

  const configPath = join(getConfigDir(), `${appId}.json`);
  await unlink(configPath).catch(() => {});
  const oldCredPath = join(getConfigDir(), 'credentials', `${appId}.json`);
  await unlink(oldCredPath).catch(() => {});

  actionEmitter.emitAction({ type: 'desktop.refreshApps' });

  const removed = await removeAppShortcut(appId);
  if (removed) {
    actionEmitter.emitAction({ type: 'desktop.removeShortcut', shortcutId: `app-${appId}` });
  }

  return ok(`Deleted app "${appId}" successfully.`);
}
