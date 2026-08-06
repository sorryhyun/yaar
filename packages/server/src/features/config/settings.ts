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
import { getSessionHub } from '../../session/session-hub.js';

export const settingsContentSchema = z.object({
  userName: z.string().optional(),
  language: z.enum(LANGUAGE_CODES as unknown as [string, ...string[]]).optional(),
  onboardingCompleted: z.boolean().optional(),
  provider: z.enum(['auto', 'claude', 'codex']).optional(),
  wallpaper: z.string().optional(),
  accentColor: z.string().optional(),
  iconSize: z.enum(['small', 'medium', 'large']).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  // Read by `features/apps/install.ts` to skip the capability-confirmation dialog.
  allowAllApps: z.boolean().optional(),
  // Persisted only; takes effect on next restart (IS_REMOTE is fixed at module load).
  remote: z.boolean().optional(),
});

/**
 * Swap the AI provider under every live session.
 *
 * Restarting the warm pool is only half of it, and doing that half alone was the bug:
 * `warmPool.cleanup()` stops the shared Codex `AppServer` while live agents' clients
 * still point at it, and nothing updates `ContextPool.providerType`, so the sessions
 * kept running turns against a provider that no longer existed. That desync is the one
 * the client-side `SET_PROVIDER` switch was deleted for; this was the other door onto it.
 *
 * Two halves close it, and each covers what the other cannot:
 *
 * - **Refuse while a turn is in flight.** A running agent is the only thing that can
 *   observe its provider dying mid-stream, and there is no honest way to migrate one.
 *   Refusing is a sentence the user can act on ("stop it, then switch").
 * - **Reset every session afterwards.** Idle agents still hold clients to the stopped
 *   `AppServer`, so they must go; `ContextPool.reset()` disposes them and re-creates
 *   monitor agents through `acquireProvider()` — which now answers with the new
 *   provider, and stamps `providerType` on the way.
 *
 * Split in two so the refusal can be decided *before* anything is persisted: settings
 * that say `codex` over a pool still running `claude` are the same desync by another
 * route.
 */
function providerSwitchRefusal(): string | null {
  const busy = getSessionHub()
    .all()
    .filter((s) => (s.getPool()?.getStats().busyAgents ?? 0) > 0);
  if (busy.length === 0) return null;
  return `Cannot switch providers while ${busy.length} session(s) have a turn in flight. Stop the running agents and try again.`;
}

/** The other half of {@link providerSwitchRefusal} — run only after it returned null. */
async function applyProviderSwitch(): Promise<void> {
  const warmPool = getWarmPool();
  await warmPool.cleanup();
  await warmPool.initialize();

  for (const session of getSessionHub().all()) {
    try {
      await session.getPool()?.reset();
    } catch (err) {
      console.error('[settings] Provider switch: session reset failed:', err);
    }
  }
}

/**
 * Apply a settings patch: validate, persist, swap the provider if it changed, and tell
 * the desktop what moved.
 *
 * **The one implementation.** The `yaar://config/settings` verb and
 * `PATCH /api/settings` are two doors onto the same act, and they used to be two
 * implementations of it — with *different* change detection (the verb compared against
 * the persisted setting, the route against `WarmPool.getPreferredProvider()`), and with
 * only the verb validating its input or emitting `desktop.updateSettings`. A REST caller
 * could write an unvalidated field and leave every open desktop showing the old value.
 */
export async function applySettings(
  content: Record<string, unknown>,
): Promise<{ ok: true; settings: Settings } | { ok: false; message: string }> {
  const result = settingsContentSchema.safeParse(content);
  if (!result.success) return { ok: false, message: `Invalid settings content: ${result.error.message}` };

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
  if (result.data.theme !== undefined) partial.theme = result.data.theme;
  if (result.data.allowAllApps !== undefined) partial.allowAllApps = result.data.allowAllApps;
  if (result.data.remote !== undefined) partial.remote = result.data.remote;

  const providerChanging = partial.provider !== undefined && partial.provider !== current.provider;
  if (providerChanging) {
    const refusal = providerSwitchRefusal();
    if (refusal) return { ok: false, message: refusal };
  }

  const settings = await updateSettings(partial);

  if (providerChanging) await applyProviderSwitch();

  // Emit desktop.updateSettings with only the changed fields
  const settingsKeys: (keyof DesktopUpdateSettingsAction['settings'])[] = [
    'userName',
    'language',
    'wallpaper',
    'accentColor',
    'iconSize',
    'theme',
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
  return { ok: true, settings };
}

/** The `yaar://config/settings` door onto {@link applySettings}. */
export async function handleSetSettings(content: Record<string, unknown>) {
  const result = await applySettings(content);
  return result.ok ? ok(JSON.stringify(result.settings, null, 2)) : error(result.message);
}

export async function handleGetSettings() {
  const settings = await readSettings();
  return { settings };
}
