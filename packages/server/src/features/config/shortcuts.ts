/**
 * Config section: shortcuts — desktop shortcuts.
 */

import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getSessionId } from '../../agents/session.js';
import {
  readShortcuts,
  addShortcut,
  removeShortcut,
  updateShortcut,
} from '../../storage/shortcuts.js';
import { ServerEventType, type DesktopShortcut, type OSAction } from '@yaar/shared';

/**
 * Broadcast a desktop shortcut action to the frontend.
 *
 * Uses the session-scoped 'desktop-shortcut' channel so it reaches the frontend
 * regardless of whether the caller is an AI agent or an iframe verb request.
 * (The generic 'action' channel is filtered by ToolActionBridge's agentId check,
 * which rejects iframe-originated actions like 'iframe:configurations'.)
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
    // Fallback for non-session contexts (e.g. AI agent MCP tools)
    actionEmitter.emitAction(action);
  }
}

export const shortcutContentSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  icon: z.string().optional(),
  iconType: z.enum(['emoji', 'image']).optional(),
  /** URI target: yaar://apps/{id}, yaar://storage/{path}, https://..., etc. */
  target: z.string().optional(),
  osActions: z.array(z.record(z.string(), z.unknown())).optional(),
  skill: z.string().optional(),
  /** Assign shortcut to a folder. */
  folderId: z.string().optional(),
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
    if (data.folderId !== undefined) updates.folderId = data.folderId;
    if (Object.keys(updates).length === 0) {
      return error('No updates provided.');
    }
    const updated = await updateShortcut(data.id, updates);
    if (!updated) {
      return error(`Shortcut "${data.id}" not found.`);
    }
    broadcastDesktopAction({
      type: 'desktop.updateShortcut',
      shortcutId: data.id,
      updates,
    } as OSAction);
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
    ...(data.folderId && { folderId: data.folderId }),
    createdAt: Date.now(),
  };
  await addShortcut(shortcut);
  broadcastDesktopAction({ type: 'desktop.createShortcut', shortcut } as OSAction);
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
  broadcastDesktopAction({
    type: 'desktop.removeShortcut',
    shortcutId,
  } as OSAction);
  return ok(`Shortcut "${shortcutId}" removed.`);
}
