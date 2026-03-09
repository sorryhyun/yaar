/**
 * Config section: hooks — event-driven automation.
 */

import { z } from 'zod';
import { ok, error } from '../../utils.js';
import { actionEmitter } from '../../action-emitter.js';
import type { HookAction } from '../../system/hooks.js';
import { addHook, loadHooks, removeHook } from '../../system/hooks.js';

export const hookContentSchema = z.object({
  event: z.enum(['launch', 'tool_use']),
  label: z.string(),
  filter: z
    .object({
      toolName: z.union([z.string(), z.array(z.string())]),
    })
    .optional(),
  action: z.object({
    type: z.enum(['interaction', 'os_action']),
    payload: z.union([
      z.string(),
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())),
    ]),
  }),
});

export async function handleSetHook(content: Record<string, unknown>) {
  const result = hookContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid hooks content: ${result.error.message}`);

  const { event, label, filter } = result.data;

  const approved = await actionEmitter.showPermissionDialog(
    'Add Hook',
    `The AI wants to add a hook: **${label}** (${event}). Allow?`,
    'config_hook',
    event,
  );

  if (!approved) {
    return error('Permission denied — hook was not added.');
  }

  const hook = await addHook(event, result.data.action as HookAction, label, filter);
  return ok(`Hook registered: "${hook.label}" (${hook.id})`);
}

export async function handleGetHooks() {
  const hooks = await loadHooks();
  return { hooks };
}

export async function handleRemoveHook(hookId: string) {
  const confirmed = await actionEmitter.showConfirmDialog(
    'Remove Hook',
    `Remove hook "${hookId}"?`,
    'Remove',
    'Cancel',
  );

  if (!confirmed) {
    return ok('Cancelled — hook was not removed.');
  }

  const removed = await removeHook(hookId);
  if (!removed) {
    return error(`Hook "${hookId}" not found.`);
  }
  return ok(`Hook "${hookId}" removed.`);
}
