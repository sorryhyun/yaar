// The host side of the app: install, uninstall, list, and the two-phase publish,
// all over `yaar://apps/{id}` and all requiring this app's `yaar://apps/` permission.

import { del, invoke, list } from '@bundled/yaar';
import { parseInstalledAny } from '../parsers/index.js';
import type { ConfirmOutcome, InstalledApp, PreparedPublication } from '../types.js';

/** Every call below addresses one app by the same URI shape. */
function appUri(app: { id: string }): string {
  return 'yaar://apps/' + app.id;
}

/** Install an app via yaar://apps/{appId}. */
export async function hostInstall(app: { id: string }): Promise<void> {
  await invoke(appUri(app), { action: 'install' });
}

/** Delete an app via yaar://apps/{appId}. */
export async function hostDelete(app: { id: string }): Promise<void> {
  await del(appUri(app));
}

/** Fetch installed apps via the yaar://apps list verb. */
export async function hostListInstalled(): Promise<InstalledApp[]> {
  return parseInstalledAny(await list('yaar://apps'));
}

/**
 * Two-phase publish over `yaar://apps/{id}`. `prepare` freezes the exact bytes and
 * returns their digest; `confirm` ships those frozen bytes after the user approves;
 * `cancel` discards the freeze. The host refuses `confirm` on source drift unless
 * `acknowledgeDrift` is set — the dialog surfaces that as a "Publish anyway" step.
 *
 * The three casts below are unchecked on purpose: these are host replies, not
 * external JSON, and the dialog already treats every field as optional.
 */
export async function hostPreparePublish(app: { id: string }): Promise<PreparedPublication> {
  return (await invoke(appUri(app), { action: 'publish_prepare' })) as PreparedPublication;
}

/**
 * `acceptTermsVersion` is sent only when the user ticked the agreement box in this
 * dialog — it names the exact terms version they read, and the host refuses any
 * other. Omitting it on a publish that needs it is what produces `terms_required`.
 */
export async function hostConfirmPublish(
  app: { id: string },
  publicationId: string,
  acknowledgeDrift: boolean,
  acceptTermsVersion?: string,
): Promise<ConfirmOutcome> {
  return (await invoke(appUri(app), {
    action: 'publish_confirm',
    publicationId,
    acknowledgeDrift,
    ...(acceptTermsVersion ? { acceptTermsVersion } : {}),
  })) as ConfirmOutcome;
}

export async function hostCancelPublish(app: { id: string }, publicationId: string): Promise<void> {
  await invoke(appUri(app), { action: 'publish_cancel', publicationId });
}
