/**
 * Config section: settings — user preferences.
 */

import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import type { Settings } from '../../storage/settings.js';
import { readSettings, updateSettings, LANGUAGE_CODES } from '../../storage/settings.js';
import type { DesktopUpdateSettingsAction } from '@yaar/shared';
import { actionEmitter } from '../../session/action-emitter.js';
import { getWarmPool } from '../../providers/factory.js';

export const settingsContentSchema = z.object({
  userName: z.string().optional(),
  language: z.enum(LANGUAGE_CODES as unknown as [string, ...string[]]).optional(),
  onboardingCompleted: z.boolean().optional(),
  provider: z.enum(['auto', 'claude', 'codex']).optional(),
  wallpaper: z.string().optional(),
  accentColor: z.string().optional(),
  iconSize: z.enum(['small', 'medium', 'large']).optional(),
});

export async function handleSetSettings(content: Record<string, unknown>) {
  const result = settingsContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid settings content: ${result.error.message}`);

  const current = await readSettings();

  const partial: Partial<Settings> = {};
  if (result.data.userName !== undefined) partial.userName = result.data.userName;
  if (result.data.language !== undefined) partial.language = result.data.language;
  if (result.data.onboardingCompleted !== undefined)
    partial.onboardingCompleted = result.data.onboardingCompleted;
  if (result.data.provider !== undefined) partial.provider = result.data.provider;
  if (result.data.wallpaper !== undefined) partial.wallpaper = result.data.wallpaper;
  if (result.data.accentColor !== undefined) partial.accentColor = result.data.accentColor;
  if (result.data.iconSize !== undefined) partial.iconSize = result.data.iconSize;

  const settings = await updateSettings(partial);

  // Restart warm pool when provider actually changes
  if (partial.provider !== undefined && partial.provider !== current.provider) {
    const warmPool = getWarmPool();
    await warmPool.cleanup();
    await warmPool.initialize();
  }

  // Emit desktop.updateSettings with only the changed fields
  const settingsKeys: (keyof DesktopUpdateSettingsAction['settings'])[] = [
    'userName',
    'language',
    'wallpaper',
    'accentColor',
    'iconSize',
  ];
  const changedSettings: DesktopUpdateSettingsAction['settings'] = {};
  for (const key of settingsKeys) {
    if (key in partial && partial[key] !== current[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (changedSettings as any)[key] = partial[key];
    }
  }
  if (Object.keys(changedSettings).length > 0) {
    actionEmitter.emitAction({
      type: 'desktop.updateSettings',
      settings: changedSettings,
    });
  }

  actionEmitter.emitAction({ type: 'desktop.refreshApps' });
  return ok(JSON.stringify(settings, null, 2));
}

export async function handleGetSettings() {
  const settings = await readSettings();
  return { settings };
}
