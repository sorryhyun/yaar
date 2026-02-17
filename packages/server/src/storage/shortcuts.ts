/**
 * CRUD helpers for desktop shortcuts stored in config/shortcuts.json.
 */

import { configRead, configWrite } from './storage-manager.js';
import type { DesktopShortcut } from '@yaar/shared';

const SHORTCUTS_FILE = 'shortcuts.json';

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
