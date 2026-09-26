/**
 * App install/uninstall logic, behind the app handlers in handlers/apps/.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { rm, unlink, mkdir, rename } from 'fs/promises';
import { compileTypeScript } from '@yaar/compiler';
import { ok, error, type VerbResult } from '../../lib/verb-result.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { listApps } from './discovery.js';
import { notifyAppChanged } from './changed.js';
import { INSTALL_ROOT, appIdRefusal, resolveAppDir } from './roots.js';
import { saveAppGrant, clearAppGrant } from '../../storage/app-grants.js';
import {
  readAppCapabilities,
  heldCapabilities,
  addedCapabilities,
  capabilityLines,
  grantFor,
  isEmpty,
} from './capabilities.js';
import { getStorageDir, MARKET_URL } from '../../config.js';
import { errMessage } from '@yaar/lib/errors';
import { getConfigDir } from '../../storage/storage-manager.js';
import { readSettings } from '../../storage/settings.js';
import { extractAppArchive } from './archive.js';

export async function installApp(appId: string): Promise<VerbResult> {
  // The id becomes a path segment under INSTALL_ROOT and an identity every permission
  // check is written against, so it is checked before either use. Nothing downstream
  // vetted it: the marketplace 404 was doing the job by accident, for ids that happen
  // not to exist there.
  const refusal = appIdRefusal(appId);
  if (refusal) return error(refusal);

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

  // Extract to a staging directory first so we can inspect permissions before finalizing.
  // The archive never touches disk on the way there: it is already in memory from the
  // download, and `Bun.Archive` reads it from there.
  const tmpDir = join(getStorageDir(), '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const stagingDir = join(tmpDir, `staging-${appId}`);

  await mkdir(stagingDir, { recursive: true });
  try {
    await extractAppArchive(new Uint8Array(await res.arrayBuffer()), stagingDir);
  } catch (err: unknown) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return error(`Failed to extract app archive: ${errMessage(err)}`);
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
        const confirmed = await actionEmitter.showPermissionDialog({
          title: isUpdate ? 'App Update Permissions' : 'App Permissions',
          // The message is the lead sentence alone. The request itself travels as
          // structured rows, which is the only way the dialog can demote a raw URI or
          // flag a broad grant — a pre-formatted string can only be one weight.
          message: lead,
          toolName: 'app_install',
          context: appId,
          confirmText: isUpdate ? 'Update' : 'Install',
          cancelText: 'Cancel',
          capabilities: capabilityLines(asking),
        });

        if (!confirmed) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          return error(`Installation of "${appId}" was cancelled by the user.`);
        }
      }
    }
  }

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

  if (existsSync(join(appDir, 'src', 'main.ts'))) {
    // Title and bundles default from the app.json just installed.
    const compileResult = await compileTypeScript(appDir);
    if (!compileResult.success) {
      // The files are on disk either way, so everything that caches them has to hear
      // about it — only the success message is withheld.
      await notifyAppChanged(appId, { retire: false });
      return error(
        `Installed "${appId}" but compilation failed: ${compileResult.errors?.join(', ') ?? 'Unknown error'}`,
      );
    }
  }

  // An update replaced the files under anything still running the previous version.
  await notifyAppChanged(appId, { retire: isUpdate });

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

  const configPath = join(getConfigDir(), `${appId}.json`);
  await unlink(configPath).catch(() => {});

  // Forget what was approved, so reinstalling asks again rather than silently
  // reviving a grant against a manifest the user never saw.
  await clearAppGrant(appId);

  // Its windows are running an app that no longer exists; the shortcut goes with it.
  await notifyAppChanged(appId, { retire: true });

  return ok(`Deleted app "${appId}" successfully.`);
}
