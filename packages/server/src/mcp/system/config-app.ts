/**
 * Config section: app — per-app configuration (credentials, preferences, etc.).
 *
 * Each app's config is stored at config/{appId}.json as a flat JSON object.
 * Replaces the old apps_read_config / apps_write_config tools.
 */

import { z } from 'zod';
import { ok, error } from '../utils.js';
import {
  readAppConfig,
  writeAppConfig,
  removeAppConfig,
  listAppConfigs,
} from '../../mcp/apps/config.js';

export const appSetFields = {
  appId: z.string().optional().describe('(app) App ID (folder name in apps/)'),
  appConfig: z
    .record(z.string(), z.any())
    .optional()
    .describe('(app) Config key-value pairs to merge into the app config'),
};

export const appRemoveFields = {
  appId: z.string().optional().describe('App ID whose config to remove'),
  appConfigKey: z
    .string()
    .optional()
    .describe('Specific key to remove (omit to delete entire app config)'),
};

export async function handleSetApp(args: Record<string, any>) {
  if (!args.appId || !args.appConfig) {
    return error('app section requires appId and appConfig fields.');
  }

  const result = await writeAppConfig(args.appId, args.appConfig);
  if (!result.success) return error(result.error!);
  return ok(`Config updated for app "${args.appId}".`);
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
