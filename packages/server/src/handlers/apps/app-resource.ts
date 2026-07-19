/**
 * The app itself — `yaar://apps` and `yaar://apps/{appId}`.
 *
 * These are the terminal cases of the composite in `register.ts`: they run only after
 * the db and storage sub-paths have declined the URI, so they may assume the URI names
 * an app and nothing under it.
 */

import type { OSAction } from '@yaar/shared';
import type { ResourceHandler, VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { ok, okJson, okResource, okLinks, error, extractIdFromUri } from '../utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { listApps } from '../../features/apps/discovery.js';
import { describeApp, loadAppSkillWithManifest } from '../../features/apps/describe.js';
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
      })),
    );
  },
};

export async function describeApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');

  const result = await describeApp(appId);
  if (!result) return error(`App "${appId}" not found.`);

  result.uri = resolved.sourceUri;
  return okJson(result);
}

/** Read an app's SKILL.md (with its protocol manifest appended). */
export async function readApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');

  const result = await loadAppSkillWithManifest(appId);
  if (result === null) return error(`No SKILL.md found for app "${appId}".`);

  return okResource(resolved.sourceUri, result, 'text/markdown');
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

  if (payload.action === 'set_badge') {
    const count = (payload.count as number) ?? 0;
    const osAction: OSAction = { type: 'app.badge', appId, count };
    actionEmitter.emitAction(osAction);
    return ok(count > 0 ? `Badge set to ${count} on "${appId}"` : `Badge cleared on "${appId}"`);
  }

  if (payload.action === 'install') {
    const { installApp } = await import('../../features/apps/install.js');
    return installApp(appId);
  }

  if (payload.action === 'publish') {
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
  }

  if (payload.action === 'clone') {
    const { cloneAppSource } = await import('../../features/dev/clone.js');
    const result = await cloneAppSource(appId);
    if (!result.success) return error(result.error!);
    return okJson({ files: result.files, meta: result.meta });
  }

  return error(`Unknown action "${payload.action}".`);
}

export async function deleteApplication(resolved: ResolvedUri): Promise<VerbResult> {
  const appId = extractIdFromUri(resolved.sourceUri, 'apps');
  if (!appId) return error('App ID required.');
  return uninstallApp(appId);
}
