/**
 * Config section: app — per-app configuration (credentials, preferences, etc.).
 *
 * Each app's config is stored at config/{appId}.json as a flat JSON object.
 */

import { z } from 'zod';
import {
  ok,
  error,
  notFoundError,
  okJsonResource,
  okMissing,
  type VerbResult,
} from '../../lib/verb-result.js';
import type { ReadOptions } from '../../lib/read-options.js';
import { readAppConfig, writeAppConfig, removeAppConfig, listAppConfigs } from '../apps/config.js';

export const appContentSchema = z.object({
  appId: z.string(),
  config: z.record(z.string(), z.any()),
});

export async function handleSetApp(content: Record<string, unknown>) {
  const result = appContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid app content: ${result.error.message}`);

  const { appId, config } = result.data;
  const writeResult = await writeAppConfig(appId, config);
  if (!writeResult.success) return error(writeResult.error!);
  return ok(`Config updated for app "${appId}".`);
}

/** Every app's config, keyed by app id — the `yaar://config/app` listing. */
export async function handleGetApp() {
  const configs = await listAppConfigs();
  return { app: configs };
}

/**
 * Read one app's config — `yaar://config/app/{appId}`.
 *
 * An app with no config file yet is answered the way storage answers an absent file:
 * `null` when the caller passed `missingOk`, otherwise a failure tagged not-found. It
 * used to be a *success* whose body was `{ app: { [id]: null, error } }`, which is
 * neither — `missingOk` could not produce its `null`, and a caller without it could not
 * catch the absence either.
 */
export async function handleReadApp(
  uri: string,
  appId: string,
  options?: ReadOptions,
): Promise<VerbResult> {
  const result = await readAppConfig(appId);
  if (!result.success) {
    if (result.notFound) return options?.missingOk ? okMissing() : notFoundError(result.error!);
    return error(result.error!);
  }
  return okJsonResource(uri, { app: { [appId]: result.content } });
}

export async function handleRemoveApp(appId: string, key?: string) {
  const result = await removeAppConfig(appId, key);
  if (!result.success) return error(result.error!);
  if (key) {
    return ok(`Removed key "${key}" from app "${appId}" config.`);
  }
  return ok(`Removed all config for app "${appId}".`);
}
