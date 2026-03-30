/**
 * App install/uninstall logic extracted from handlers/apps.ts.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink, mkdir, rename } from 'fs/promises';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/agent-context.js';
import { listApps } from './discovery.js';
import { PROJECT_ROOT, MARKET_URL } from '../../config.js';
import { getConfigDir } from '../../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { readSettings } from '../../storage/settings.js';
import { ServerEventType, type OSAction } from '@yaar/shared';
import type { PermissionEntry } from '../../http/routes/verb.js';

/**
 * Broadcast a desktop action through the session-scoped 'desktop-shortcut' channel
 * so it reaches the frontend even outside agent context (e.g. HTTP route handlers).
 */
function broadcastDesktopAction(action: OSAction): void {
  const sessionId = getSessionId();
  if (sessionId) {
    actionEmitter.emit('desktop-shortcut', {
      sessionId,
      event: {
        type: ServerEventType.ACTIONS,
        actions: [action],
        agentId: 'system',
      },
    });
  } else {
    actionEmitter.emitAction(action);
  }
}

/** Format permission entries into a human-readable string for the dialog. */
function formatPermissions(permissions: PermissionEntry[]): string {
  return permissions
    .map((p) => {
      if (typeof p === 'string') return `  • ${p}`;
      const verbs = p.verbs?.length ? ` (${p.verbs.join(', ')})` : '';
      return `  • ${p.uri}${verbs}`;
    })
    .join('\n');
}

/** Read permissions from an extracted app's app.json. */
async function readAppPermissions(appDir: string): Promise<PermissionEntry[] | null> {
  try {
    const metaContent = await Bun.file(join(appDir, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    if (Array.isArray(meta.permissions) && meta.permissions.length > 0) {
      return meta.permissions;
    }
  } catch {
    // No app.json or invalid JSON
  }
  return null;
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

  // Extract to a staging directory first so we can inspect permissions before finalizing
  const tmpDir = join(PROJECT_ROOT, 'storage', '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${appId}.tar.gz`);
  const stagingDir = join(tmpDir, `staging-${appId}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  await Bun.write(tmpFile, buffer);

  await mkdir(stagingDir, { recursive: true });
  try {
    const tarProc = Bun.spawnSync([
      'tar',
      'xzf',
      tmpFile,
      '--strip-components=1',
      '-C',
      stagingDir,
    ]);
    if (tarProc.exitCode !== 0) {
      throw new Error(
        tarProc.stderr.toString().trim() || `tar exited with code ${tarProc.exitCode}`,
      );
    }
  } catch (err: unknown) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return error(
      `Failed to extract app archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }

  // Check for permissions and prompt user before installing.
  // Skip the permission dialog during onboarding or when allowAllApps is enabled.
  if (!isUpdate) {
    const permissions = await readAppPermissions(stagingDir);
    if (permissions && permissions.length > 0) {
      const settings = await readSettings();
      if (settings.onboardingCompleted && !settings.allowAllApps) {
        const confirmed = await actionEmitter.showPermissionDialog(
          'App Permissions',
          `"${appId}" requests the following permissions:\n\n${formatPermissions(permissions)}\n\nDo you want to allow this?`,
          'app_install',
          appId,
          'Install',
          'Cancel',
        );

        if (!confirmed) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          return error(`Installation of "${appId}" was cancelled by the user.`);
        }
      }
    }
  }

  // Move from staging to final app directory
  if (isUpdate) {
    await rm(appDir, { recursive: true, force: true });
  }
  await mkdir(join(appDir, '..'), { recursive: true });
  try {
    await rename(stagingDir, appDir);
  } catch {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return error('Failed to move app to install directory.');
  }

  const apps = await listApps();
  const installed = apps.find((a) => a.id === appId);
  if (installed && installed.createShortcut !== false) {
    const shortcut = await ensureAppShortcut({
      id: installed.id,
      name: installed.name,
      icon: installed.icon,
      iconType: installed.iconType,
    });
    broadcastDesktopAction({ type: 'desktop.createShortcut', shortcut } as OSAction);
  }

  // Emit refreshApps AFTER shortcut is persisted to disk, so the frontend
  // fetch of /api/shortcuts (triggered by appsVersion bump) includes the new shortcut.
  broadcastDesktopAction({ type: 'desktop.refreshApps' } as OSAction);

  return ok(`${isUpdate ? 'Updated' : 'Installed'} app "${appId}" successfully.`);
}

export async function uninstallApp(appId: string): Promise<VerbResult> {
  const appDir = join(PROJECT_ROOT, 'apps', appId);
  if (!existsSync(appDir)) return error(`App "${appId}" is not installed.`);

  await rm(appDir, { recursive: true, force: true });

  const configPath = join(getConfigDir(), `${appId}.json`);
  await unlink(configPath).catch(() => {});

  const removed = await removeAppShortcut(appId);
  if (removed) {
    broadcastDesktopAction({
      type: 'desktop.removeShortcut',
      shortcutId: `app-${appId}`,
    } as OSAction);
  }

  // Emit refreshApps AFTER shortcut removal is persisted to disk.
  broadcastDesktopAction({ type: 'desktop.refreshApps' } as OSAction);

  return ok(`Deleted app "${appId}" successfully.`);
}
