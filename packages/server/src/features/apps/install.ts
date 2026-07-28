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
import { PROJECT_ROOT, MARKET_URL } from '../../config.js';
import { errMessage } from '../../lib/errors.js';
import { getConfigDir } from '../../storage/storage-manager.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { readSettings } from '../../storage/settings.js';
import { ServerEventType, type OSAction } from '@yaar/shared';
import type { PermissionEntry } from '../../http/access.js';
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

/**
 * What an installed app can hold that the user should get a say in.
 *
 * `controls` and `streams` are deliberately absent: `discovery.ts` strips both for
 * any app whose source isn't `bundled`, so a marketplace app that declares them is
 * granted nothing and asking about them would describe authority it never gets.
 * `bundles` is the opposite case — it is carried onto the iframe token regardless of
 * source (`getAppMeta`), so it is a real grant and belongs in the dialog.
 */
interface AppCapabilities {
  permissions: PermissionEntry[];
  bundles: string[];
}

/** What each gated SDK actually lets an app do, in the user's terms. */
const BUNDLE_DESCRIPTIONS: Record<string, string> = {
  'yaar-dev': 'compile, typecheck, and deploy apps on this machine',
  'yaar-web': 'drive a browser — navigate, click, and read pages',
  'yaar-ml': 'download and run machine-learning models in the browser',
};

/** Stable identity for a permission entry, so two manifests can be compared. */
function permissionKey(p: PermissionEntry): string {
  if (typeof p === 'string') return p;
  return `${p.uri}|${(p.verbs ?? []).slice().sort().join(',')}`;
}

/** Format capabilities into a human-readable string for the dialog. */
function formatCapabilities(caps: AppCapabilities): string {
  const sections: string[] = [];
  if (caps.permissions.length > 0) {
    const lines = caps.permissions.map((p) => {
      if (typeof p === 'string') return `  • ${p}`;
      const verbs = p.verbs?.length ? ` (${p.verbs.join(', ')})` : '';
      return `  • ${p.uri}${verbs}`;
    });
    sections.push(`Access to:\n${lines.join('\n')}`);
  }
  if (caps.bundles.length > 0) {
    const lines = caps.bundles.map((b) => {
      const what = BUNDLE_DESCRIPTIONS[b];
      return what ? `  • ${b} — ${what}` : `  • ${b}`;
    });
    sections.push(`Privileged SDKs:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Read the capabilities an app's app.json declares. Missing/invalid → none. */
async function readAppCapabilities(appDir: string): Promise<AppCapabilities> {
  const caps: AppCapabilities = { permissions: [], bundles: [] };
  try {
    const metaContent = await Bun.file(join(appDir, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    if (Array.isArray(meta.permissions)) caps.permissions = meta.permissions;
    if (Array.isArray(meta.bundles)) {
      caps.bundles = meta.bundles.filter((b: unknown): b is string => typeof b === 'string');
    }
  } catch {
    // No app.json or invalid JSON
  }
  return caps;
}

/**
 * The capabilities in `next` that `previous` did not already hold.
 *
 * An update used to skip the dialog outright, so a v2 that newly asked for
 * `yaar-web` was granted it without the user ever seeing the request. Only the
 * *added* capabilities are prompted for — re-confirming what is already installed
 * on every routine update would train the user to click through.
 */
function addedCapabilities(previous: AppCapabilities, next: AppCapabilities): AppCapabilities {
  const heldPermissions = new Set(previous.permissions.map(permissionKey));
  const heldBundles = new Set(previous.bundles);
  return {
    permissions: next.permissions.filter((p) => !heldPermissions.has(permissionKey(p))),
    bundles: next.bundles.filter((b) => !heldBundles.has(b)),
  };
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
  {
    const requested = await readAppCapabilities(stagingDir);
    const asking = isUpdate
      ? addedCapabilities(await readAppCapabilities(appDir), requested)
      : requested;

    if (asking.permissions.length > 0 || asking.bundles.length > 0) {
      const settings = await readSettings();
      if (settings.onboardingCompleted && !settings.allowAllApps) {
        const lead = isUpdate
          ? `The update to "${appId}" additionally requests:`
          : `"${appId}" requests the following:`;
        const confirmed = await actionEmitter.showPermissionDialog(
          isUpdate ? 'App Update Permissions' : 'App Permissions',
          `${lead}\n\n${formatCapabilities(asking)}\n\nDo you want to allow this?`,
          'app_install',
          appId,
          isUpdate ? 'Update' : 'Install',
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
