/**
 * What the user approved for an *installed* app, recorded at install time.
 *
 * A bundled app's app.json is part of the release: shipping a line of JSON in it is
 * already a decision the user made by installing YAAR. An app from the market is not
 * — so the privileged declarations (`subagents`, `streams`) were simply stripped for
 * any app whose source isn't `bundled`. That closed self-grant, but it also made two
 * capabilities *unreachable* by the apps they were built for: `chitchats` left `apps/`
 * for the market still declaring a sub-agent ceiling, and was refused with a
 * message telling the user to add the field it already had.
 *
 * This file is the missing half. The declaration in a market app's manifest is a
 * **request**; what is written here is the **grant**, made by the user in the install
 * dialog (`features/apps/install.ts`). `discovery.ts` then honours the declaration for
 * a user app only as far as the recorded grant goes, so the manifest can never widen
 * itself — an app holding `yaar-dev` can rewrite its own app.json, and without the
 * intersection that would be self-grant through the back door.
 *
 * Deliberately *not* covering `controls`: driving another app is authority over software
 * the user installed separately, and there is no consumer asking for it. It stays
 * bundled-only.
 */

import { createPersistedStore } from './persisted-store.js';

/**
 * The privileged declarations a user may grant an installed app.
 *
 * Field names mirror the *manifest* keys, so a grant can be read against the app.json
 * it answers. The user-facing prose in the install dialog still says "personas" — that
 * is the wire's word for the thing (`personaId`), and the word a person recognizes.
 */
export interface AppGrant {
  /** Ceiling the user approved for `subagents`. */
  subagents?: { max: number };
  /** Stream capabilities the user approved from `streams`. */
  streams?: string[];
}

interface AppGrantsFile {
  [appId: string]: AppGrant;
}

const store = createPersistedStore<AppGrantsFile>('app-grants.json', () => ({}));

/** What the user approved for this app, or null if nothing was ever recorded. */
export async function readAppGrant(appId: string): Promise<AppGrant | null> {
  const grants = await store.read();
  return grants[appId] ?? null;
}

/**
 * Record the user's approval. Replaces any previous grant rather than merging: the
 * manifest just approved is the whole of what the app now holds, so an update that
 * drops a capability must drop the grant with it.
 */
export async function saveAppGrant(appId: string, grant: AppGrant): Promise<void> {
  await store.update((grants) => {
    if (!grant.subagents && !grant.streams?.length) delete grants[appId];
    else grants[appId] = grant;
  });
}

/** Forget an app's grant — called on uninstall, so a reinstall asks again. */
export async function clearAppGrant(appId: string): Promise<void> {
  await store.update((grants) => {
    delete grants[appId];
  });
}

/** @internal — test hook; resets the cached file. */
export function _resetAppGrantsForTest(value: AppGrantsFile | null = null): void {
  store._setForTest(value);
}
