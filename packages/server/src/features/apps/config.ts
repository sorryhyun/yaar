/**
 * App configuration — read/write per-app config stored at config/{appId}.json.
 *
 * Each app gets a single JSON file containing all its config (credentials,
 * preferences, etc.). Old credential locations are auto-migrated on first read.
 */

import { stat, mkdir, unlink, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { getConfigDir } from '../../storage/storage-manager.js';
import { PROJECT_ROOT } from '../../config.js';

function getAppConfigPath(appId: string): string {
  return join(getConfigDir(), `${appId}.json`);
}

// ── Legacy paths (for migration) ────────────────────────────────────

function getOldCredentialsDir(): string {
  return join(getConfigDir(), 'credentials');
}

function getOldCredentialsPath(appId: string): string {
  return join(getOldCredentialsDir(), `${appId}.json`);
}

function getOldAppCredentialsPath(appId: string): string {
  return join(PROJECT_ROOT, 'apps', appId, 'credentials.json');
}

function getLegacyStorageCredentialsPath(appId: string): string {
  return join(PROJECT_ROOT, 'storage', 'credentials', `${appId}.json`);
}

/**
 * Migrate credentials from old locations to config/{appId}.json.
 * Checks (in order): config/credentials/{appId}.json, storage/credentials/, apps/{appId}/.
 */
async function migrateIfNeeded(appId: string): Promise<void> {
  const newPath = getAppConfigPath(appId);

  // Already has new-format config — skip
  try {
    await stat(newPath);
    return;
  } catch {
    // Not yet migrated
  }

  const legacyPaths = [
    getOldCredentialsPath(appId),
    getLegacyStorageCredentialsPath(appId),
    getOldAppCredentialsPath(appId),
  ];

  for (const oldPath of legacyPaths) {
    try {
      await stat(oldPath);
    } catch {
      continue;
    }

    // Found old credentials — migrate
    try {
      await mkdir(getConfigDir(), { recursive: true });
      const content = await Bun.file(oldPath).text();
      await Bun.write(newPath, content);
      await unlink(oldPath);
      console.log(`[Apps] Migrated config for ${appId} → config/${appId}.json`);
    } catch (err) {
      console.error(`[Apps] Failed to migrate config for ${appId}:`, err);
    }
    return;
  }
}

/**
 * Check if an app has any config (in current or legacy locations).
 */
export async function hasConfig(appId: string): Promise<boolean> {
  try {
    await stat(getAppConfigPath(appId));
    return true;
  } catch {
    /* not in new location */
  }

  try {
    await stat(getOldCredentialsPath(appId));
    return true;
  } catch {
    /* not in old config/credentials/ */
  }

  try {
    await stat(getLegacyStorageCredentialsPath(appId));
    return true;
  } catch {
    /* not in storage/credentials/ */
  }

  try {
    await stat(getOldAppCredentialsPath(appId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an app's config. Auto-migrates from legacy locations.
 */
export async function readAppConfig(
  appId: string,
): Promise<{ success: boolean; content?: unknown; error?: string }> {
  try {
    await migrateIfNeeded(appId);
    const content = await Bun.file(getAppConfigPath(appId)).text();
    try {
      return { success: true, content: JSON.parse(content) };
    } catch {
      return { success: true, content };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    if (error.includes('ENOENT')) {
      return { success: false, error: `No config found for app "${appId}".` };
    }
    return { success: false, error };
  }
}

/**
 * Write (merge) config for an app. Merges the provided keys into the
 * existing config object, creating the file if it doesn't exist.
 */
export async function writeAppConfig(
  appId: string,
  config: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    await migrateIfNeeded(appId);
    await mkdir(getConfigDir(), { recursive: true });

    const configPath = getAppConfigPath(appId);

    // Read existing config to merge
    let existing: Record<string, unknown> = {};
    try {
      const raw = await Bun.file(configPath).text();
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const merged = { ...existing, ...config };
    await Bun.write(configPath, JSON.stringify(merged, null, 2));
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Remove an app's config (or a specific key within it).
 */
export async function removeAppConfig(
  appId: string,
  key?: string,
): Promise<{ success: boolean; error?: string }> {
  const configPath = getAppConfigPath(appId);

  try {
    if (!key) {
      // Remove entire config file
      await unlink(configPath);
      return { success: true };
    }

    // Remove specific key
    const raw = await Bun.file(configPath).text();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { success: false, error: 'Config is not a JSON object.' };
    }
    if (!(key in parsed)) {
      return { success: false, error: `Key "${key}" not found in app "${appId}" config.` };
    }
    delete parsed[key];
    await Bun.write(configPath, JSON.stringify(parsed, null, 2));
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    if (error.includes('ENOENT')) {
      return { success: false, error: `No config found for app "${appId}".` };
    }
    return { success: false, error };
  }
}

/**
 * List all app configs (reads config/*.json, excluding system config files).
 */
export async function listAppConfigs(): Promise<Record<string, unknown>> {
  const configDir = getConfigDir();
  const systemFiles = new Set([
    'hooks.json',
    'settings.json',
    'shortcuts.json',
    'permissions.json',
    'mounts.json',
    'curl_allowed_domains.yaml',
  ]);

  const result: Record<string, unknown> = {};
  try {
    const entries = await readdir(configDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json') || systemFiles.has(entry)) continue;
      const appId = basename(entry, '.json');
      try {
        const raw = await Bun.file(join(configDir, entry)).text();
        result[appId] = JSON.parse(raw);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Config dir doesn't exist yet
  }
  return result;
}
