/**
 * Config section: app — per-app configuration (credentials, preferences, etc.).
 *
 * Each app's config is stored at config/{appId}.json as a flat JSON object.
 */

import { z } from 'zod';
import { ok, error } from '../utils.js';
import {
  readAppConfig,
  writeAppConfig,
  removeAppConfig,
  listAppConfigs,
} from '../apps/config.js';

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

export async function handleGetApp(appId?: string) {
  if (appId) {
    const result = await readAppConfig(appId);
    if (!result.success) return { app: { [appId]: null, error: result.error } };
    return { app: { [appId]: result.content } };
  }
  // List all app configs
  const configs = await listAppConfigs();
  return { app: configs };
}

export async function handleRemoveApp(appId: string, key?: string) {
  const result = await removeAppConfig(appId, key);
  if (!result.success) return error(result.error!);
  if (key) {
    return ok(`Removed key "${key}" from app "${appId}" config.`);
  }
  return ok(`Removed all config for app "${appId}".`);
}
