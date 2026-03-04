/**
 * Config section: hooks — event-driven automation.
 */

import { z } from 'zod';
import { ok, error } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import { addHook, loadHooks, removeHook } from './hooks.js';

export const hookSetFields = {
  event: z
    .enum(['launch', 'tool_use'])
    .optional()
    .describe('(hooks) The event that triggers this hook'),
  filter: z
    .object({
      toolName: z
        .union([z.string(), z.array(z.string())])
        .describe('Tool name(s) to match (e.g., "apps:clone")'),
    })
    .optional()
    .describe('(hooks) Filter for tool_use hooks — which tools trigger this hook'),
  action: z
    .object({
      type: z
        .enum(['interaction', 'os_action'])
        .describe(
          'Action type: "interaction" injects a user message, "os_action" emits OS Actions',
        ),
      payload: z
        .union([
          z.string(),
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())),
        ])
        .describe('String for interaction, object or array for os_action'),
    })
    .optional()
    .describe('(hooks) What happens when the hook fires'),
};

export const hookRemoveFields = {
  hookId: z.string().optional().describe('The hook ID to remove (e.g., "hook-1")'),
};

export async function handleSetHook(args: Record<string, any>) {
  if (!args.event || !args.action || !args.label) {
    return error('hooks section requires event, action, and label fields.');
  }

  const approved = await actionEmitter.showPermissionDialog(
    'Add Hook',
    `The AI wants to add a hook: **${args.label}** (${args.event}). Allow?`,
    'config_hook',
    args.event,
  );

  if (!approved) {
    return error('Permission denied — hook was not added.');
  }

  const hook = await addHook(args.event, args.action, args.label, args.filter);
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
