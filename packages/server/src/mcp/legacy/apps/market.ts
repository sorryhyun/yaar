/**
 * Marketplace tools - browse and install apps from the YAAR marketplace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { unlink } from 'fs/promises';
import { ok, error } from '../../utils.js';
import { actionEmitter } from '../../action-emitter.js';
import { PROJECT_ROOT } from '../../../config.js';
import { getConfigDir } from '../../../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../../../storage/shortcuts.js';
import { listApps } from '../../../features/apps/discovery.js';

const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

export function registerMarketTools(server: McpServer): void {
  // Browse marketplace
  server.registerTool(
    'market_list',
    {
      description:
        'List all apps available in the YAAR marketplace. Shows name, icon, description, version, and author for each app.',
    },
    async () => {
      const res = await fetch(`${MARKET_URL}/api/apps`);
      if (!res.ok) {
        return error(`Failed to fetch marketplace (${res.status} ${res.statusText})`);
      }

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

      if (!data.apps || data.apps.length === 0) {
        return ok('No apps available in the marketplace.');
      }

      const lines = data.apps.map(
        (app) =>
          `- ${app.icon} **${app.name}** (${app.id}) v${app.version}\n  ${app.description} — by ${app.author}`,
      );

      return ok(`Marketplace apps:\n${lines.join('\n')}`);
    },
  );

  // Install app from marketplace
  server.registerTool(
    'market_get',
    {
      description:
        'Download and install an app from the YAAR marketplace into the local apps/ directory. Overwrites if already installed.',
      inputSchema: {
        appId: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/, 'Invalid app ID format')
          .describe('The app ID to install from the marketplace'),
      },
    },
    async (args) => {
      const { appId } = args;
      const appsDir = join(PROJECT_ROOT, 'apps');
      const appDir = join(appsDir, appId);
      const isUpdate = existsSync(appDir);

      // Download tar.gz
      const res = await fetch(`${MARKET_URL}/api/apps/${appId}/download`);
      if (!res.ok) {
        if (res.status === 404) {
          return error(`App "${appId}" not found in the marketplace.`);
        }
        return error(`Failed to download app (${res.status} ${res.statusText})`);
      }

      // Write to temp file
      const tmpDir = join(PROJECT_ROOT, 'storage', '.tmp');
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = join(tmpDir, `${appId}.tar.gz`);

      const buffer = Buffer.from(await res.arrayBuffer());
      await Bun.write(tmpFile, buffer);

      // Extract tar.gz and clean up temp file
      await mkdir(appDir, { recursive: true });
      try {
        const tarProc = Bun.spawnSync([
          'tar',
          'xzf',
          tmpFile,
          '--strip-components=1',
          '-C',
          appDir,
        ]);
        if (tarProc.exitCode !== 0) {
          throw new Error(
            tarProc.stderr.toString().trim() || `tar exited with code ${tarProc.exitCode}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(`Failed to extract app archive: ${msg}`);
      } finally {
        await unlink(tmpFile).catch(() => {});
      }

      // Refresh desktop apps
      actionEmitter.emitAction({ type: 'desktop.refreshApps' });

      // Auto-create desktop shortcut if app wants one
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
    },
  );

  // Delete (uninstall) an app
  server.registerTool(
    'market_delete',
    {
      description:
        'Delete an installed app. Removes the app folder from apps/ and its credentials from config/credentials/.',
      inputSchema: {
        appId: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/, 'Invalid app ID format')
          .describe('The app ID to delete'),
      },
    },
    async (args) => {
      const { appId } = args;
      const appDir = join(PROJECT_ROOT, 'apps', appId);

      if (!existsSync(appDir)) {
        return error(`App "${appId}" is not installed.`);
      }

      // Remove the app directory
      await rm(appDir, { recursive: true, force: true });

      // Remove app config if it exists
      const configPath = join(getConfigDir(), `${appId}.json`);
      await unlink(configPath).catch(() => {});
      // Also clean up old credentials location
      const oldCredPath = join(getConfigDir(), 'credentials', `${appId}.json`);
      await unlink(oldCredPath).catch(() => {});

      // Refresh desktop apps
      actionEmitter.emitAction({ type: 'desktop.refreshApps' });

      // Remove desktop shortcut
      const removed = await removeAppShortcut(appId);
      if (removed) {
        actionEmitter.emitAction({ type: 'desktop.removeShortcut', shortcutId: `app-${appId}` });
      }

      return ok(`Deleted app "${appId}" successfully.`);
    },
  );
}
