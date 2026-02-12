/**
 * Marketplace tools - browse and install apps from the YAAR marketplace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ok } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import { PROJECT_ROOT } from '../../config.js';

const execFileAsync = promisify(execFile);

const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

export function registerMarketTools(server: McpServer): void {
  // Browse marketplace
  server.registerTool(
    'market_list',
    {
      description: 'List all apps available in the YAAR marketplace. Shows name, icon, description, version, and author for each app.',
    },
    async () => {
      const res = await fetch(`${MARKET_URL}/api/apps`);
      if (!res.ok) {
        return ok(`Error: Failed to fetch marketplace (${res.status} ${res.statusText})`);
      }

      const data = await res.json() as { apps: Array<{ id: string; name: string; icon: string; description: string; version: string; author: string }> };

      if (!data.apps || data.apps.length === 0) {
        return ok('No apps available in the marketplace.');
      }

      const lines = data.apps.map((app) =>
        `- ${app.icon} **${app.name}** (${app.id}) v${app.version}\n  ${app.description} — by ${app.author}`
      );

      return ok(`Marketplace apps:\n${lines.join('\n')}`);
    }
  );

  // Install app from marketplace
  server.registerTool(
    'market_get',
    {
      description: 'Download and install an app from the YAAR marketplace into the local apps/ directory. Overwrites if already installed.',
      inputSchema: {
        appId: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Invalid app ID format').describe('The app ID to install from the marketplace'),
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
          return ok(`Error: App "${appId}" not found in the marketplace.`);
        }
        return ok(`Error: Failed to download app (${res.status} ${res.statusText})`);
      }

      // Write to temp file
      const tmpDir = join(PROJECT_ROOT, 'storage', '.tmp');
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = join(tmpDir, `${appId}.tar.gz`);

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(tmpFile, buffer);

      // Extract tar.gz
      await mkdir(appDir, { recursive: true });
      try {
        await execFileAsync('tar', ['xzf', tmpFile, '--strip-components=1', '-C', appDir]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return ok(`Error: Failed to extract app archive: ${msg}`);
      }

      // Refresh desktop apps
      actionEmitter.emitAction({ type: 'desktop.refreshApps' });

      return ok(`${isUpdate ? 'Updated' : 'Installed'} app "${appId}" successfully.`);
    }
  );
}
