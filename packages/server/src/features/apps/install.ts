/**
 * App install/uninstall logic extracted from handlers/apps.ts.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink, mkdir, rename } from 'fs/promises';
import { compileTypeScript } from '@yaar/compiler';
import type { VerbResult } from '../../handlers/uri-registry.js';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/agent-context.js';
import { listApps, invalidateAppsCache } from './discovery.js';
import { INSTALL_ROOT, resolveAppDir } from './roots.js';
import { saveAppGrant, clearAppGrant } from '../../storage/app-grants.js';
import {
  readAppCapabilities,
  heldCapabilities,
  addedCapabilities,
  capabilityLines,
  grantFor,
  isEmpty,
} from './capabilities.js';
import { PROJECT_ROOT, MARKET_URL } from '../../config.js';
import { errMessage } from '../../lib/errors.js';
import { getConfigDir } from '../../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { readSettings } from '../../storage/settings.js';
import { ServerEventType, type OSAction } from '@yaar/shared';
import { buildTarExtractInvocation } from './archive.js';

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

export async function installApp(appId: string): Promise<VerbResult> {
  // Update an existing app in place; fresh installs land in the user-apps root
  // (git-ignored) so they never pollute the tracked bundled tree.
  const existingDir = resolveAppDir(appId);
  const isUpdate = existingDir !== null;
  const appDir = existingDir ?? join(INSTALL_ROOT, appId);

  // Protect system apps: they ship with the release and can't be replaced from
  // the marketplace.
  if (isUpdate) {
    const existing = (await listApps()).find((a) => a.id === appId);
    if (existing?.kind === 'system') {
      return error(
        `"${appId}" is a protected system app and cannot be replaced from the marketplace.`,
      );
    }
  }

  const res = await fetch(`${MARKET_URL}/api/apps/${appId}/download`);
  if (!res.ok) {
    if (res.status === 404) return error(`App "${appId}" not found in the marketplace.`);
    return error(`Failed to download app (${res.status})`);
  }

  // Extract to a staging directory first so we can inspect permissions before finalizing
  const tmpDir = join(PROJECT_ROOT, 'storage', '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpFileName = `${appId}.tar.gz`;
  const stagingDirName = `staging-${appId}`;
  const tmpFile = join(tmpDir, tmpFileName);
  const stagingDir = join(tmpDir, stagingDirName);

  const buffer = Buffer.from(await res.arrayBuffer());
  await Bun.write(tmpFile, buffer);

  await mkdir(stagingDir, { recursive: true });
  try {
    const tarInvocation = buildTarExtractInvocation(tmpDir, tmpFileName, stagingDirName);
    const tarProc = Bun.spawnSync(tarInvocation.argv, { cwd: tarInvocation.cwd });
    if (tarProc.exitCode !== 0) {
      throw new Error(
        tarProc.stderr.toString().trim() || `tar exited with code ${tarProc.exitCode}`,
      );
    }
  } catch (err: unknown) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return error(`Failed to extract app archive: ${errMessage(err)}`);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }

  // Check what the app asks for and prompt the user before installing. On an
  // update only the *newly added* capabilities are prompted for.
  // Skip the dialog during onboarding or when allowAllApps is enabled.
  const requested = await readAppCapabilities(stagingDir);
  {
    const asking = isUpdate
      ? addedCapabilities(await heldCapabilities(appDir, appId), requested)
      : requested;

    if (!isEmpty(asking)) {
      const settings = await readSettings();
      if (settings.onboardingCompleted && !settings.allowAllApps) {
        const lead = isUpdate
          ? `The update to "${appId}" additionally requests:`
          : `"${appId}" requests the following:`;
        const confirmed = await actionEmitter.showPermissionDialog(
          isUpdate ? 'App Update Permissions' : 'App Permissions',
          // The message is now the lead sentence alone. The request itself travels as
          // structured rows, which is the only way the dialog can demote a raw URI or
          // flag a broad grant — a pre-formatted string can only be one weight.
          lead,
          'app_install',
          appId,
          isUpdate ? 'Update' : 'Install',
          'Cancel',
          undefined, // default deadline
          capabilityLines(asking),
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

  // Record what the user just approved. This also runs on the paths that skipped the
  // dialog (onboarding, `allowAllApps`): those are the user declining to be *asked*,
  // not the user declining. Only an explicit Cancel returns above, before the app is
  // on disk at all.
  await saveAppGrant(appId, grantFor(requested));

  // Compile the app if it has source code
  if (existsSync(join(appDir, 'src', 'main.ts'))) {
    let bundles: string[] | undefined;
    let title = appId;
    try {
      const meta = JSON.parse(await Bun.file(join(appDir, 'app.json')).text());
      if (Array.isArray(meta.bundles)) bundles = meta.bundles;
      if (typeof meta.name === 'string') title = meta.name;
    } catch {
      // No app.json or invalid JSON
    }
    const compileResult = await compileTypeScript(appDir, { title, bundles });
    if (!compileResult.success) {
      return error(
        `Installed "${appId}" but compilation failed: ${compileResult.errors?.join(', ') ?? 'Unknown error'}`,
      );
    }
  }

  invalidateAppsCache(); // app files just changed on disk — re-scan below
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
  const appDir = resolveAppDir(appId);
  if (!appDir) return error(`App "${appId}" is not installed.`);

  // System apps are core to the desktop — refuse to delete them.
  const app = (await listApps()).find((a) => a.id === appId);
  if (app?.kind === 'system') {
    return error(`"${appId}" is a protected system app and cannot be uninstalled.`);
  }

  await rm(appDir, { recursive: true, force: true });
  invalidateAppsCache(); // app dir removed — drop stale cached listing

  const configPath = join(getConfigDir(), `${appId}.json`);
  await unlink(configPath).catch(() => {});

  // Forget what was approved, so reinstalling asks again rather than silently
  // reviving a grant against a manifest the user never saw.
  await clearAppGrant(appId);

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
