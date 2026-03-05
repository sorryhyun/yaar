/**
 * CRUD helpers for desktop shortcuts stored in config/shortcuts.json.
 */

import { configRead, configWrite } from './storage-manager.js';
import type { DesktopShortcut } from '@yaar/shared';
import { buildYaarUri, extractAppId } from '@yaar/shared';

const SHORTCUTS_FILE = 'shortcuts.json';

/** Migrate legacy shortcut format ({ type: 'app', target: 'storage' }) to URI-based. */
function normalizeShortcut(s: DesktopShortcut): DesktopShortcut {
  const legacy = s as DesktopShortcut & { type?: string };
  if (!legacy.type || s.target.startsWith('yaar://') || s.target.startsWith('https://') || s.target.startsWith('http://')) {
    return s;
  }
  console.warn(`[shortcuts] Migrating legacy shortcut "${s.id}" (type=${legacy.type}) to URI-based target`);
  const { type, ...rest } = legacy;
  switch (type) {
    case 'app':
    case 'skill':
      return { ...rest, target: buildYaarUri('apps', s.target || s.id) };
    case 'file':
      return { ...rest, target: buildYaarUri('storage', s.target) };
    default:
      return rest;
  }
}

export async function readShortcuts(): Promise<DesktopShortcut[]> {
  const result = await configRead(SHORTCUTS_FILE);
  if (!result.success || !result.content) return [];
  try {
    const shortcuts: DesktopShortcut[] = JSON.parse(result.content);
    return shortcuts.map(normalizeShortcut);
  } catch {
    return [];
  }
}

async function writeShortcuts(shortcuts: DesktopShortcut[]): Promise<void> {
  await configWrite(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2));
}

export async function addShortcut(shortcut: DesktopShortcut): Promise<void> {
  const shortcuts = await readShortcuts();
  shortcuts.push(shortcut);
  await writeShortcuts(shortcuts);
}

export async function removeShortcut(shortcutId: string): Promise<boolean> {
  const shortcuts = await readShortcuts();
  const idx = shortcuts.findIndex((s) => s.id === shortcutId);
  if (idx === -1) return false;
  shortcuts.splice(idx, 1);
  await writeShortcuts(shortcuts);
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

export async function ensureAppShortcut(app: {
  id: string;
  name: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
}): Promise<DesktopShortcut> {
  const shortcuts = await readShortcuts();
  const shortcutId = `app-${app.id}`;
  const existing = shortcuts.find((s) => s.id === shortcutId);
  if (existing) return existing;
  const shortcut: DesktopShortcut = {
    id: shortcutId,
    label: app.name,
    icon: app.icon || '📦',
    ...(app.iconType && { iconType: app.iconType }),
    target: buildYaarUri('apps', app.id),
    createdAt: Date.now(),
  };
  shortcuts.push(shortcut);
  await writeShortcuts(shortcuts);
  return shortcut;
}

export async function removeAppShortcut(appId: string): Promise<boolean> {
  return removeShortcut(`app-${appId}`);
}

/**
 * Sync shortcuts with the current app list:
 * - Remove shortcuts for apps that no longer exist or have createShortcut: false
 * - Ensure shortcuts exist for apps that should have them
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
    if (!autoShortcutAppIds.has(app.id)) continue;
    const shortcutId = `app-${app.id}`;
    if (!result.some((s) => s.id === shortcutId)) {
      result.push({
        id: shortcutId,
        label: app.name,
        icon: app.icon || '📦',
        ...(app.iconType && { iconType: app.iconType }),
        target: buildYaarUri('apps', app.id),
        createdAt: Date.now(),
      });
      changed = true;
    }
  }

  if (changed) {
    await writeShortcuts(result);
  }

  return removedIds;
}
