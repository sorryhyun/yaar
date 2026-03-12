/**
 * Config section: settings — user preferences.
 */

import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import type { Settings } from '../../storage/settings.js';
import { readSettings, updateSettings, LANGUAGE_CODES } from '../../storage/settings.js';
import { actionEmitter } from '../../session/action-emitter.js';

export const settingsContentSchema = z.object({
  userName: z.string().optional(),
  language: z.enum(LANGUAGE_CODES as unknown as [string, ...string[]]).optional(),
  onboardingCompleted: z.boolean().optional(),
});

export async function handleSetSettings(content: Record<string, unknown>) {
  const result = settingsContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid settings content: ${result.error.message}`);

  const partial: Partial<Settings> = {};
  if (result.data.userName !== undefined) partial.userName = result.data.userName;
  if (result.data.language !== undefined) partial.language = result.data.language;
  if (result.data.onboardingCompleted !== undefined)
    partial.onboardingCompleted = result.data.onboardingCompleted;
  const settings = await updateSettings(partial);
  actionEmitter.emitAction({ type: 'desktop.refreshApps' });
  return ok(JSON.stringify(settings, null, 2));
}

export async function handleGetSettings() {
  const settings = await readSettings();
  return { settings };
}
