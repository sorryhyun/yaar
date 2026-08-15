/**
 * Config section: hooks — event-driven automation.
 */

import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import type { HookAction } from './hooks.js';
import { addHook, loadHooks, removeHook } from './hooks.js';
import { describeSchedule, validateSchedule } from './hook-schedule.js';

const stringOrStrings = z.union([z.string(), z.array(z.string())]);

export const hookContentSchema = z
  .object({
    event: z.enum(['launch', 'tool_use', 'schedule']),
    label: z.string(),
    filter: z
      .object({
        toolName: stringOrStrings.optional(),
        verb: stringOrStrings.optional(),
        uri: stringOrStrings.optional(),
        action: stringOrStrings.optional(),
      })
      .optional(),
    schedule: z
      .object({
        every: z.string().optional(),
        at: z.string().optional(),
      })
      .optional(),
    monitorId: z.string().optional(),
    action: z.object({
      type: z.enum(['interaction', 'os_action']),
      payload: z.union([
        z.string(),
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())),
      ]),
    }),
  })
  // A schedule on a non-schedule hook is refused rather than ignored: it would otherwise
  // be a hook that reads as timed, is stored as timed, and never fires.
  .superRefine((content, ctx) => {
    if (content.event !== 'schedule') {
      if (content.schedule) {
        ctx.addIssue({
          code: 'custom',
          path: ['schedule'],
          message: `A schedule only applies to event "schedule", not "${content.event}".`,
        });
      }
      return;
    }
    if (!content.schedule) {
      ctx.addIssue({
        code: 'custom',
        path: ['schedule'],
        message: 'A "schedule" hook needs a `schedule` — e.g. { "every": "30m" } or { "at": "09:00" }.',
      });
      return;
    }
    const problem = validateSchedule(content.schedule);
    if (problem) ctx.addIssue({ code: 'custom', path: ['schedule'], message: problem });
  });

export async function handleSetHook(content: Record<string, unknown>) {
  const result = hookContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid hooks content: ${result.error.message}`);

  const { event, label, filter, schedule, monitorId } = result.data;

  // The cadence belongs in the dialog, not just the label: "every 1m" is the difference
  // between a hook and a standing charge, and it is the user who pays for it.
  const when = schedule ? `${event}, ${describeSchedule(schedule)}` : event;
  const approved = await actionEmitter.showPermissionDialog({
    title: 'Add Hook',
    message: `The AI wants to add a hook: **${label}** (${when}). Allow?`,
    toolName: 'config_hook',
    context: event,
  });

  if (!approved) {
    return error('Permission denied — hook was not added.');
  }

  const hook = await addHook(event, result.data.action as HookAction, label, filter, {
    schedule,
    monitorId,
  });
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
