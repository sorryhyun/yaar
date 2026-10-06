/**
 * CRUD helpers for desktop shortcuts stored in config/shortcuts.json.
 */

import { configRead, configWrite } from './storage-manager.js';
import type { DesktopShortcut } from '@yaar/shared';
import { buildYaarUri, extractAppId } from '@yaar/shared';

const SHORTCUTS_FILE = 'shortcuts.json';
/**
 * Apps whose auto-created shortcut the user deleted. Without it a deleted `app-{id}` looks
 * exactly like one never created, and the app's next update or the next startup puts it back.
 */
const DISMISSED_FILE = 'dismissed-app-shortcuts.json';
const APP_SHORTCUT_PREFIX = 'app-';

/** An app's auto-created desktop shortcut. `ensureAppShortcut` and `syncAppShortcuts` must agree. */
function buildAppShortcut(app: {
  id: string;
  name: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
}): DesktopShortcut {
  return {
    id: `app-${app.id}`,
    label: app.name,
    icon: app.icon || '📦',
    ...(app.iconType && { iconType: app.iconType }),
    target: buildYaarUri('apps', app.id),
    createdAt: Date.now(),
  };
}

export async function readShortcuts(): Promise<DesktopShortcut[]> {
  const result = await configRead(SHORTCUTS_FILE);
  if (!result.success || !result.content) return [];
  try {
    return JSON.parse(result.content);
  } catch {
    return [];
  }
}

async function writeShortcuts(shortcuts: DesktopShortcut[]): Promise<void> {
  await configWrite(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2));
}

async function readDismissed(): Promise<Set<string>> {
  const result = await configRead(DISMISSED_FILE);
  if (!result.success || !result.content) return new Set();
  try {
    const parsed: unknown = JSON.parse(result.content);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function writeDismissed(appIds: Set<string>): Promise<void> {
  await configWrite(DISMISSED_FILE, JSON.stringify([...appIds].sort(), null, 2));
}

async function setDismissed(appId: string, dismissed: boolean): Promise<void> {
  const appIds = await readDismissed();
  if (appIds.has(appId) === dismissed) return;
  if (dismissed) appIds.add(appId);
  else appIds.delete(appId);
  await writeDismissed(appIds);
}

/** The app an auto-created shortcut id belongs to, or null for any other shortcut. */
function appIdOfAutoShortcut(shortcutId: string): string | null {
  return shortcutId.startsWith(APP_SHORTCUT_PREFIX)
    ? shortcutId.slice(APP_SHORTCUT_PREFIX.length)
    : null;
}

/** Add a shortcut on the user's behalf. Re-adding an app's own shortcut lifts its dismissal. */
export async function addShortcut(shortcut: DesktopShortcut): Promise<void> {
  const shortcuts = await readShortcuts();
  shortcuts.push(shortcut);
  await writeShortcuts(shortcuts);
  const appId = appIdOfAutoShortcut(shortcut.id);
  if (appId) await setDismissed(appId, false);
}

async function deleteShortcut(shortcutId: string): Promise<boolean> {
  const shortcuts = await readShortcuts();
  const idx = shortcuts.findIndex((s) => s.id === shortcutId);
  if (idx === -1) return false;
  shortcuts.splice(idx, 1);
  await writeShortcuts(shortcuts);
  return true;
}

/**
 * Remove a shortcut on the user's behalf. Deleting an app's auto-created shortcut is
 * remembered, so updating the app or restarting does not bring it back.
 */
export async function removeShortcut(shortcutId: string): Promise<boolean> {
  if (!(await deleteShortcut(shortcutId))) return false;
  const appId = appIdOfAutoShortcut(shortcutId);
  if (appId) await setDismissed(appId, true);
  return true;
}

export async function updateShortcut(
  shortcutId: string,
  updates: Partial<Omit<DesktopShortcut, 'id' | 'createdAt'>>,
): Promise<DesktopShortcut | null> {
  const shortcuts = await readShortcuts();
  const shortcut = shortcuts.find((s) => s.id === shortcutId);
  if (!shortcut) return null;
  Object.assign(shortcut, updates);
  await writeShortcuts(shortcuts);
  return shortcut;
}

/**
 * Give an app its desktop shortcut unless it already has one or the user deleted it.
 * `shortcut` is null when the user deleted it. `created` says which — the frontend
 * *appends* a `desktop.createShortcut`, so announcing one that was already there puts a
 * second icon on the desktop.
 */
export async function ensureAppShortcut(app: {
  id: string;
  name: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
}): Promise<{ shortcut: DesktopShortcut | null; created: boolean }> {
  const shortcuts = await readShortcuts();
  const existing = shortcuts.find((s) => s.id === `app-${app.id}`);
  if (existing) return { shortcut: existing, created: false };
  if ((await readDismissed()).has(app.id)) return { shortcut: null, created: false };
  const shortcut = buildAppShortcut(app);
  shortcuts.push(shortcut);
  await writeShortcuts(shortcuts);
  return { shortcut, created: true };
}

/**
 * Remove an app's shortcut because the app is gone or no longer wants one — not a user
 * decision, so nothing is remembered.
 */
export async function removeAppShortcut(appId: string): Promise<boolean> {
  return deleteShortcut(`app-${appId}`);
}

/** The app was uninstalled: installing it again is a first install and gets a shortcut. */
export async function forgetAppShortcutDismissal(appId: string): Promise<void> {
  await setDismissed(appId, false);
}

/**
 * Sync shortcuts with the current app list:
 * - Remove shortcuts for apps that no longer exist (createShortcut: false only
 *   prevents auto-creation; existing shortcuts are kept)
 * - Ensure shortcuts exist for apps that should have them, unless the user deleted one
 * - Forget deletions for apps that no longer exist
 * Returns the list of removed shortcut IDs (for emitting frontend actions).
 */
export async function syncAppShortcuts(
  apps: Array<{
    id: string;
    name: string;
    icon?: string;
    iconType?: 'emoji' | 'image';
    createShortcut?: boolean;
  }>,
): Promise<string[]> {
  const shortcuts = await readShortcuts();
  const dismissed = await readDismissed();
  const allAppIds = new Set(apps.map((a) => a.id));
  const autoShortcutAppIds = new Set(
    apps.filter((a) => a.createShortcut !== false).map((a) => a.id),
  );
  const removedIds: string[] = [];
  let changed = false;

  // Remove shortcuts only for apps that no longer exist (not just createShortcut: false)
  const result = shortcuts.filter((s) => {
    const appId = extractAppId(s.target);
    if (appId && !allAppIds.has(appId)) {
      removedIds.push(s.id);
      changed = true;
      return false;
    }
    return true;
  });

  // Auto-create shortcuts only for apps that opt in
  for (const app of apps) {
    if (!autoShortcutAppIds.has(app.id) || dismissed.has(app.id)) continue;
    if (!result.some((s) => s.id === `app-${app.id}`)) {
      result.push(buildAppShortcut(app));
      changed = true;
    }
  }

  if (changed) {
    await writeShortcuts(result);
  }

  const stillDismissed = new Set([...dismissed].filter((id) => allAppIds.has(id)));
  if (stillDismissed.size !== dismissed.size) await writeDismissed(stillDismissed);

  return removedIds;
}
