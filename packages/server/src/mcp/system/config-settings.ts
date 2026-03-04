/**
 * Config section: settings — user preferences.
 */

import { z } from 'zod';
import { ok } from '../utils.js';
import { readSettings, updateSettings, LANGUAGE_CODES } from '../../storage/settings.js';
import { actionEmitter } from '../action-emitter.js';

export const settingsSetFields = {
  language: z
    .enum(LANGUAGE_CODES as unknown as [string, ...string[]])
    .optional()
    .describe('(settings) Language code (e.g., "en", "ko", "ja")'),
  onboardingCompleted: z.boolean().optional().describe('(settings) Mark onboarding as completed'),
};

export async function handleSetSettings(args: Record<string, any>) {
  const partial: Record<string, unknown> = {};
  if (args.language !== undefined) partial.language = args.language;
  if (args.onboardingCompleted !== undefined)
    partial.onboardingCompleted = args.onboardingCompleted;
  const settings = await updateSettings(partial as any);
  actionEmitter.emitAction({ type: 'desktop.refreshApps' });
  return ok(JSON.stringify(settings, null, 2));
}

export async function handleGetSettings() {
  const settings = await readSettings();
  return { settings };
}
