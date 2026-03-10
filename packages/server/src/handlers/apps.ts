/**
 * Apps domain handlers for the verb layer.
 *
 * Maps app operations to the verb layer:
 *
 *   list('yaar://apps')                              → list all apps
 *   read('yaar://apps/{appId}')                      → load SKILL.md
 *   invoke('yaar://apps/{appId}', { action, ... })   → set_badge, market_get
 *   delete('yaar://apps/{appId}')                    → uninstall app
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink } from 'fs/promises';
import type { OSAction } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error } from '../mcp/utils.js';
import { actionEmitter } from '../mcp/action-emitter.js';
import { listApps, loadAppSkill } from '../features/apps/discovery.js';
import { PROJECT_ROOT } from '../config.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../storage/shortcuts.js';

const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

function extractAppIdFromUri(uri: string): string {
  // yaar://apps/{appId} → appId
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)/);
  return match?.[1] ?? '';
}

export function registerAppsHandlers(registry: ResourceRegistry): void {
  // ── yaar://apps — list all apps (exact match) ──
  const listHandler: ResourceHandler = {
    description: 'List all available apps. Invoke to browse/install from marketplace.',
    verbs: ['describe', 'list', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['market_list', 'market_get'] },
        appId: { type: 'string', description: 'App ID (for market_get)' },
      },
    },

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

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (!payload?.action) return error('Payload must include "action".');

      if (payload.action === 'market_list') {
        const res = await fetch(`${MARKET_URL}/api/apps`);
        if (!res.ok) return error(`Failed to fetch marketplace (${res.status})`);
        const data = (await res.json()) as {
          apps: Array<{
            id: string;
            name: string;
            icon: string;
            description: string;
            version: string;
            author: string;
          }>;
        };
        if (!data.apps?.length) return ok('No apps available in the marketplace.');
        const lines = data.apps.map(
          (app) =>
            `- ${app.icon} **${app.name}** (${app.id}) v${app.version}\n  ${app.description} — by ${app.author}`,
        );
        return ok(`Marketplace apps:\n${lines.join('\n')}`);
      }

      if (payload.action === 'market_get') {
        if (!payload.appId) return error('"appId" is required for market_get.');
        return installApp(payload.appId as string);
      }

      return error(`Unknown action "${payload.action}".`);
    },
  };
  registry.register('yaar://apps', listHandler);

  // ── yaar://apps/{appId} — per-app operations ──
  registry.register('yaar://apps/*', {
    description:
      'A specific app. Read to load its SKILL.md, invoke to set_badge, delete to uninstall.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['set_badge'] },
        count: { type: 'number', description: 'Badge count (0 to clear)' },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const appId = extractAppIdFromUri(resolved.sourceUri);
      if (!appId) return error('App ID required.');

      const skill = await loadAppSkill(appId);
      if (skill === null) return error(`No SKILL.md found for app "${appId}".`);

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
          return ok(skill + '\n\n## Protocol\n\n' + sections.join('\n\n'));
        }
      }

      return ok(skill);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
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
      const appId = extractAppIdFromUri(resolved.sourceUri);
      if (!appId) return error('App ID required.');
      return uninstallApp(appId);
    },
  });
}

async function installApp(appId: string): Promise<VerbResult> {
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
