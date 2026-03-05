/**
 * Config section: shortcuts — desktop shortcuts.
 */

import { z } from 'zod';
import { ok, error } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import {
  readShortcuts,
  addShortcut,
  removeShortcut,
  updateShortcut,
} from '../../storage/shortcuts.js';
import type { DesktopShortcut } from '@yaar/shared';

export const shortcutContentSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  icon: z.string().optional(),
  iconType: z.enum(['emoji', 'image']).optional(),
  /** URI target: yaar://apps/{id}, yaar://storage/{path}, https://..., etc. */
  target: z.string().optional(),
  osActions: z.array(z.record(z.string(), z.unknown())).optional(),
  skill: z.string().optional(),
});

export async function handleSetShortcut(content: Record<string, unknown>) {
  const result = shortcutContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid shortcuts content: ${result.error.message}`);

  const data = result.data;

  if (data.id) {
    // Update existing shortcut
    const updates: Record<string, unknown> = {};
    if (data.label !== undefined) updates.label = data.label;
    if (data.icon !== undefined) updates.icon = data.icon;
    if (data.iconType !== undefined) updates.iconType = data.iconType;
    if (data.target !== undefined) updates.target = data.target;
    if (data.osActions !== undefined) updates.osActions = data.osActions;
    if (data.skill !== undefined) updates.skill = data.skill;
    if (Object.keys(updates).length === 0) {
      return error('No updates provided.');
    }
    const updated = await updateShortcut(data.id, updates);
    if (!updated) {
      return error(`Shortcut "${data.id}" not found.`);
    }
    actionEmitter.emitAction({
      type: 'desktop.updateShortcut',
      shortcutId: data.id,
      updates,
    });
    return ok(`Shortcut "${data.id}" updated.`);
  }

  // Create new shortcut
  if (data.skill) {
    if (!data.label || !data.icon) {
      return error('Skill shortcuts require label and icon fields.');
    }
  } else if (!data.label || !data.icon || !data.target) {
    return error('Shortcuts require label, icon, and target (URI) fields to create.');
  }
  const shortcut: DesktopShortcut = {
    id: `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: data.label!,
    icon: data.icon!,
    iconType: data.iconType,
    target: data.target || '',
    osActions: data.osActions as DesktopShortcut['osActions'],
    ...(data.skill && { skill: data.skill }),
    createdAt: Date.now(),
  };
  await addShortcut(shortcut);
  actionEmitter.emitAction({ type: 'desktop.createShortcut', shortcut });
  return ok(`Shortcut created: "${shortcut.label}" (${shortcut.id})`);
}

export async function handleGetShortcuts() {
  const shortcuts = await readShortcuts();
  return { shortcuts };
}

export async function handleRemoveShortcut(shortcutId: string) {
  const removed = await removeShortcut(shortcutId);
  if (!removed) {
    return error(`Shortcut "${shortcutId}" not found.`);
  }
  actionEmitter.emitAction({
    type: 'desktop.removeShortcut',
    shortcutId,
  });
  return ok(`Shortcut "${shortcutId}" removed.`);
}
