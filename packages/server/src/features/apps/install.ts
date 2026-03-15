/**
 * App install/uninstall logic extracted from handlers/apps.ts.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink, mkdir } from 'fs/promises';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { listApps } from './discovery.js';
import { PROJECT_ROOT, MARKET_URL } from '../../config.js';
import { getConfigDir } from '../../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';

export async function installApp(appId: string): Promise<VerbResult> {
  const appsDir = join(PROJECT_ROOT, 'apps');
  const appDir = join(appsDir, appId);
  const isUpdate = existsSync(appDir);

  const res = await fetch(`${MARKET_URL}/api/apps/${appId}/download`);
  if (!res.ok) {
    if (res.status === 404) return error(`App "${appId}" not found in the marketplace.`);
    return error(`Failed to download app (${res.status})`);
  }

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

export async function uninstallApp(appId: string): Promise<VerbResult> {
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
