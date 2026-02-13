/**
 * App configuration - read/write config files and credential management.
 */

import { readFile, writeFile, stat, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { getConfigDir } from '../../storage/storage-manager.js';
import { PROJECT_ROOT } from '../../config.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

// Centralized credentials location under config/
function getCredentialsDir(): string {
  return join(getConfigDir(), 'credentials');
}

function getCredentialsPath(appId: string): string {
  return join(getCredentialsDir(), `${appId}.json`);
}

// Old credentials locations (for migration)
function getOldCredentialsPath(appId: string): string {
  return join(APPS_DIR, appId, 'credentials.json');
}

function getLegacyStorageCredentialsPath(appId: string): string {
  return join(PROJECT_ROOT, 'storage', 'credentials', `${appId}.json`);
}

/**
 * Check if credentials exist for an app (in either location).
 */
export async function hasCredentials(appId: string): Promise<boolean> {
  // Check current location first
  try {
    await stat(getCredentialsPath(appId));
    return true;
  } catch {
    // Not in current location
  }

  // Check legacy storage/credentials/ location
  try {
    await stat(getLegacyStorageCredentialsPath(appId));
    return true;
  } catch {
    // Not in legacy storage location
  }

  // Check old apps/{appId}/credentials.json location
  try {
    await stat(getOldCredentialsPath(appId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate credentials from old location to new location.
 * Returns true if migration happened, false if already migrated or no credentials.
 */
async function migrateCredentials(appId: string): Promise<boolean> {
  const newPath = getCredentialsPath(appId);

  // Check if already in current location
  try {
    await stat(newPath);
    return false; // Already migrated
  } catch {
    // Not in current location, continue
  }

  // Try legacy locations in order: storage/credentials/ first, then apps/{appId}/
  const legacyPaths = [getLegacyStorageCredentialsPath(appId), getOldCredentialsPath(appId)];

  for (const oldPath of legacyPaths) {
    try {
      await stat(oldPath);
    } catch {
      continue; // Not in this location
    }

    // Found credentials, migrate them
    try {
      await mkdir(getCredentialsDir(), { recursive: true });
      const content = await readFile(oldPath, 'utf-8');
      await writeFile(newPath, content, 'utf-8');
      await unlink(oldPath);
      console.log(`[Apps] Migrated credentials for ${appId} to config/credentials/`);
      return true;
    } catch (err) {
      console.error(`[Apps] Failed to migrate credentials for ${appId}:`, err);
      return false;
    }
  }

  return false; // No credentials to migrate
}

/**
 * Read a config file from an app.
 * For credentials.json, uses the centralized config/credentials/ location.
 * For other files, uses the app folder.
 */
export async function readAppConfig(
  appId: string,
  filename: string = 'credentials.json',
): Promise<{ success: boolean; content?: unknown; error?: string }> {
  try {
    // Prevent directory traversal
    if (filename.includes('..') || filename.startsWith('/')) {
      return { success: false, error: 'Invalid filename' };
    }

    let configPath: string;

    // Handle credentials specially - use centralized location
    if (filename === 'credentials.json') {
      // Try migration first
      await migrateCredentials(appId);
      configPath = getCredentialsPath(appId);
    } else {
      // Other config files stay in app folder
      configPath = join(APPS_DIR, appId, filename);
    }

    const content = await readFile(configPath, 'utf-8');

    // Try to parse as JSON
    try {
      return { success: true, content: JSON.parse(content) };
    } catch {
      // Return as string if not valid JSON
      return { success: true, content };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    if (error.includes('ENOENT')) {
      return { success: false, error: `File not found: ${filename}` };
    }
    return { success: false, error };
  }
}

/**
 * Write a config file to an app.
 * For credentials.json, uses the centralized config/credentials/ location.
 * For other files, uses the app folder.
 */
export async function writeAppConfig(
  appId: string,
  filename: string,
  content: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Prevent directory traversal
    if (filename.includes('..') || filename.startsWith('/')) {
      return { success: false, error: 'Invalid filename' };
    }

    let configPath: string;

    // Handle credentials specially - use centralized location
    if (filename === 'credentials.json') {
      // Ensure credentials directory exists
      await mkdir(getCredentialsDir(), { recursive: true });
      configPath = getCredentialsPath(appId);
    } else {
      // Other config files stay in app folder
      const appPath = join(APPS_DIR, appId);
      await mkdir(appPath, { recursive: true });
      configPath = join(appPath, filename);
    }

    // Write content as JSON if object, otherwise as string
    const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await writeFile(configPath, data, 'utf-8');

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}
