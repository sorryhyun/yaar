/**
 * The app itself — `yaar://apps` and `yaar://apps/{appId}`.
 *
 * These are the terminal cases of the composite in `register.ts`: they run only after
 * the db and storage sub-paths have declined the URI, so they may assume the URI names
 * an app and nothing under it.
 *
 * `describe` is the manual (what the app is, and its protocol); `read` is the current
 * value (its effective manifest). They used to return the same kind of thing — a
 * generated reference doc from either door — which is why the monitor prompt could only
 * offer "read *or* describe" rather than instruct.
 */

import type { OSAction } from '@yaar/shared';
import type { ResourceHandler, VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { ok, okJson, okLinks, error, extractIdFromUri } from '../utils.js';
import { defineActions } from '../define-actions.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { listApps, getAppMeta } from '../../features/apps/discovery.js';
import { describeApp } from '../../features/apps/describe.js';
import { uninstallApp } from '../../features/apps/install.js';

/** `yaar://apps` — the exact-match handler listing every installed app. */
export const appsListHandler: ResourceHandler = {
  description: 'List all installed apps.',
  verbs: ['describe', 'list'],

  async list(): Promise<VerbResult> {
    const apps = await listApps();
    return okLinks(
      apps.map((app) => ({
        uri: `yaar://apps/${app.id}`,
        name: app.name,
        description: app.description,
        kind: app.kind,
        version: app.version,
      })),
    );
  },
};

/**
 * The app-level invoke actions, and the one place they are declared.
 *
 * The same list used to be written three times and no two agreed: `describe` advertised
 * `set_badge` alone, the switch implemented seven, and the schema enum named five —
 * including `write`, which is a *storage* action and was never handled here. Deriving
 * the enum and the `invokeActions` map from this table means a case cannot exist
 * undeclared and a declaration cannot exist without a case.
 */
export const appActions = defineActions<{ appId: string; p: Record<string, unknown> }>({
  set_badge: {
    description: 'Set the badge count on the app icon ({ count }; 0 clears it).',
    run: ({ appId, p }) => {
      const count = (p.count as number) ?? 0;
      const osAction: OSAction = { type: 'app.badge', appId, count };
      actionEmitter.emitAction(osAction);
      return ok(count > 0 ? `Badge set to ${count} on "${appId}"` : `Badge cleared on "${appId}"`);
    },
  },
  install: {
    description: 'Install this app from the marketplace.',
    run: async ({ appId }) => {
      const { installApp } = await import('../../features/apps/install.js');
      return installApp(appId);
    },
  },
  publish: {
    description:
      'Publish this app to the marketplace. Refused until the signed-in publisher has ' +
      "accepted the Publisher Terms in the Market Apps publish dialog — that acceptance is the user's " +
      "to give, not an agent's.",
    run: async ({ appId }) => {
      const { publishApp } = await import('../../features/apps/publish.js');
      const result = await publishApp(appId);
      if (!result.success) return error(result.error!);
      return okJson({
        published: true,
        appId,
        commit: result.commit,
        files: result.files,
        message: result.message,
      });
    },
  },
  publish_prepare: {
    description: 'Stage a publication and return its summary plus a publicationId.',
    run: async ({ appId }) => {
      const { preparePublication } = await import('../../features/apps/publish-staging.js');
      const prep = await preparePublication(appId);
      if (!prep.success) return error(prep.error);
      return okJson({ prepared: true, ...prep.summary });
    },
  },
  publish_confirm: {
    description:
      'Finalize a staged publication ({ publicationId, acknowledgeDrift?, acceptTermsVersion? }).',
    run: async ({ appId, p }) => {
      const publicationId = p.publicationId;
      if (typeof publicationId !== 'string') {
        return error('publish_confirm requires the "publicationId" from publish_prepare.');
      }
      const { finalizePublication } = await import('../../features/apps/publish-staging.js');
      const outcome = await finalizePublication(publicationId, {
        expectedAppId: appId,
        acknowledgeDrift: p.acknowledgeDrift === true,
        // Only a string is passed through: accepting the publisher terms means naming
        // the version that was read, and `true` names nothing.
        acceptTermsVersion:
          typeof p.acceptTermsVersion === 'string' ? p.acceptTermsVersion : undefined,
      });
      if (outcome.status === 'published') {
        return okJson({ published: true, appId, ...outcome.result });
      }
      // drift_detected / terms_required / expired / not_found / error are all actionable
      // states, not hard failures — hand the agent structured detail so it can
      // re-prepare, acknowledge, or tell the user to accept the terms.
      return okJson({ published: false, ...outcome });
    },
  },
  publish_cancel: {
    description: 'Discard a staged publication ({ publicationId }).',
    run: async ({ p }) => {
      const publicationId = p.publicationId;
      if (typeof publicationId !== 'string') {
        return error('publish_cancel requires a "publicationId".');
      }
      const { cancelPublication } = await import('../../features/apps/publish-staging.js');
      const cancelled = await cancelPublication(publicationId);
      return okJson({ cancelled });
    },
  },
  clone: {
    description: "Clone this app's source into a devtools project.",
    run: async ({ appId }) => {
      const { cloneAppSource } = await import('../../features/dev/clone.js');
      const result = await cloneAppSource(appId);
      if (!result.success) return error(result.error!);
      return okJson({ files: result.files, meta: result.meta });
    },
  },
});

/** The verbs `yaar://apps/{appId}` itself answers to (sub-paths declare their own). */
const APP_VERBS = ['describe', 'read', 'invoke', 'delete'] as const;

export async function describeApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');

  const facts = await describeApp(appId);
  if (!facts) return error(`App "${appId}" not found.`);

  // `verbs` and `invokeActions` come from the handler, not from the app: they describe
  // what this door does, and the door is here.
  return okJson({
    uri: resolved.sourceUri,
    ...facts,
    verbs: [...APP_VERBS],
    invokeActions: appActions.docs,
    subPaths: {
      'storage/': "The app's private files (read, list, invoke, delete).",
      'db/': "The app's SQLite collections (read, list, invoke, delete).",
      'agents/': "The app's own sub-agents, when it declares any.",
    },
  });
}

/**
 * Read an app's **effective** manifest — what it actually holds, not what it declares.
 *
 * `getAppMeta` applies the install-time grant (`features/apps/capabilities.ts`) before
 * answering, which is the difference that matters: raw `app.json` is a *declaration*,
 * and an app holding `yaar-dev` can rewrite its own. Returning the file would report
 * `subagents: { max: 5 }` for an app the user granted 2, and would report capabilities
 * for an app installed before grants existed that in fact holds nothing.
 *
 * `kind`, `source` and `version` ride along because they are not in the file at all —
 * they are decided by which root the app was found in.
 */
export async function readApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');

  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return error(`App "${appId}" not found.`);

  const meta = await getAppMeta(appId);

  return okJson({
    uri: resolved.sourceUri,
    id: app.id,
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    kind: app.kind,
    source: app.source,
    ...(app.version ? { version: app.version } : {}),
    ...(app.author ? { author: app.author } : {}),
    installed: true,
    isCompiled: app.isCompiled,
    hasProtocol: meta?.hasProtocol === true,
    hasConfig: app.hasConfig,
    ...(app.permissions?.length ? { permissions: app.permissions } : {}),
    ...(meta?.bundles?.length ? { bundles: meta.bundles } : {}),
    ...(meta?.controls?.length ? { controls: meta.controls } : {}),
    // Post-grant, hence possibly narrower than the manifest asks for — see the note above.
    ...(meta?.subagents ? { subagents: meta.subagents } : {}),
    ...(meta?.streams?.length ? { streams: meta.streams } : {}),
    ...(meta?.messaging ? { messaging: meta.messaging } : {}),
    ...(app.variant ? { variant: app.variant } : {}),
    ...(app.dockEdge ? { dockEdge: app.dockEdge } : {}),
  });
}

/** Listing a specific app (rather than its storage) is not a meaningful request. */
export function listApplication(): VerbResult {
  return error(
    'Cannot list an app directly. Use list("yaar://apps") for all apps, ' +
      'or list("yaar://apps/{appId}/storage/") for app storage.',
  );
}

export async function invokeApplication(
  resolved: ResolvedUri,
  payload?: Record<string, unknown>,
): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');
  if (!payload?.action) return error('Payload must include "action".');

  return appActions.dispatch(payload.action as string, { appId, p: payload });
}

export async function deleteApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');
  return uninstallApp(appId);
}
