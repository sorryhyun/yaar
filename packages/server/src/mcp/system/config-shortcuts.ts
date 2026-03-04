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

export const shortcutSetFields = {
  shortcutId: z
    .string()
    .optional()
    .describe('(shortcuts) Shortcut ID — if provided, updates existing; if absent, creates new'),
  icon: z.string().optional().describe('(shortcuts) Emoji icon or storage image path'),
  iconType: z
    .enum(['emoji', 'image'])
    .optional()
    .describe('(shortcuts) Icon type (default: emoji)'),
  shortcutType: z
    .enum(['file', 'url', 'action', 'app', 'skill'])
    .optional()
    .describe('(shortcuts) Shortcut type'),
  target: z
    .string()
    .optional()
    .describe('(shortcuts) Storage path (file), URL (url), or action identifier (action)'),
  osActions: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      '(shortcuts) OS Actions to execute client-side on click (bypasses AI). Each object needs a "type" field.',
    ),
  skill: z
    .string()
    .optional()
    .describe(
      '(shortcuts) Skill/macro instructions — sent to AI when the shortcut is clicked (type "skill")',
    ),
};

export const shortcutRemoveFields = {
  shortcutId: z.string().optional().describe('The shortcut ID to remove'),
};

export async function handleSetShortcut(args: Record<string, any>) {
  if (args.shortcutId) {
    // Update existing shortcut
    const updates: Record<string, unknown> = {};
    if (args.label !== undefined) updates.label = args.label;
    if (args.icon !== undefined) updates.icon = args.icon;
    if (args.iconType !== undefined) updates.iconType = args.iconType;
    if (args.shortcutType !== undefined) updates.type = args.shortcutType;
    if (args.target !== undefined) updates.target = args.target;
    if (args.osActions !== undefined) updates.osActions = args.osActions;
    if (args.skill !== undefined) updates.skill = args.skill;
    if (Object.keys(updates).length === 0) {
      return error('No updates provided.');
    }
    const updated = await updateShortcut(args.shortcutId, updates);
    if (!updated) {
      return error(`Shortcut "${args.shortcutId}" not found.`);
    }
    actionEmitter.emitAction({
      type: 'desktop.updateShortcut',
      shortcutId: args.shortcutId,
      updates,
    });
    return ok(`Shortcut "${args.shortcutId}" updated.`);
  }

  // Create new shortcut
  if (args.shortcutType === 'skill') {
    if (!args.label || !args.icon || !args.skill) {
      return error('skill shortcuts require label, icon, and skill fields.');
    }
  } else if (!args.label || !args.icon || !args.shortcutType || !args.target) {
    return error(
      'shortcuts section requires label, icon, shortcutType, and target fields to create.',
    );
  }
  const shortcut: DesktopShortcut = {
    id: `shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: args.label!,
    icon: args.icon!,
    iconType: args.iconType,
    type: args.shortcutType!,
    target: args.target || '',
    osActions: args.osActions as DesktopShortcut['osActions'],
    ...(args.skill && { skill: args.skill }),
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
