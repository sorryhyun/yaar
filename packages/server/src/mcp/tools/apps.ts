/**
 * Apps tools - discover and manage apps in the apps/ directory.
 *
 * Apps are convention-based folders containing:
 * - SKILL.md: Instructions for the AI on how to use the app
 * - Other config files as needed
 *
 * Credentials are stored centrally in config/credentials/{appId}.json
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, writeFile, stat, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { ok } from '../utils.js';
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

/** Supported image extensions for app icons */
const ICON_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'];

export interface AppInfo {
  id: string;
  name: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  hasSkill: boolean;
  hasCredentials: boolean;
  isCompiled?: boolean;  // Has index.html (TypeScript compiled app)
}

/**
 * Check if credentials exist for an app (in either location).
 */
async function hasCredentials(appId: string): Promise<boolean> {
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
  const legacyPaths = [
    getLegacyStorageCredentialsPath(appId),
    getOldCredentialsPath(appId),
  ];

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
 * List all apps in the apps/ directory.
 */
export async function listApps(): Promise<AppInfo[]> {
  try {
    const entries = await readdir(APPS_DIR, { withFileTypes: true });
    const apps: AppInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const appId = entry.name;
      const appPath = join(APPS_DIR, appId);

      // Check for SKILL.md
      let hasSkill = false;
      try {
        await stat(join(appPath, 'SKILL.md'));
        hasSkill = true;
      } catch {
        // File doesn't exist
      }

      // Check for credentials (in either location)
      const appHasCredentials = await hasCredentials(appId);

      // Check for compiled app (index.html)
      let isCompiled = false;
      try {
        await stat(join(appPath, 'index.html'));
        isCompiled = true;
      } catch {
        // File doesn't exist
      }

      // Check for app.json metadata
      let icon: string | undefined;
      let iconType: 'emoji' | 'image' | undefined;
      let displayName: string | undefined;
      try {
        const metaContent = await readFile(join(appPath, 'app.json'), 'utf-8');
        const meta = JSON.parse(metaContent);
        icon = meta.icon;
        if (icon) iconType = 'emoji';
        displayName = meta.name;
      } catch {
        // No metadata or invalid JSON
      }

      // Check for icon image file (takes priority over emoji)
      try {
        const files = await readdir(appPath);
        for (const file of files) {
          const lower = file.toLowerCase();
          const dotIdx = lower.lastIndexOf('.');
          if (dotIdx === -1) continue;
          const baseName = lower.slice(0, dotIdx);
          const ext = lower.slice(dotIdx);
          if (baseName === 'icon' && ICON_IMAGE_EXTENSIONS.includes(ext)) {
            icon = `/api/apps/${appId}/icon`;
            iconType = 'image';
            break;
          }
        }
      } catch {
        // Could not read directory
      }

      // Convert kebab-case or snake_case to Title Case (fallback)
      const name = displayName ?? appId
        .split(/[-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      apps.push({
        id: appId,
        name,
        icon,
        iconType,
        hasSkill,
        hasCredentials: appHasCredentials,
        isCompiled,
      });
    }

    return apps;
  } catch {
    // apps/ directory doesn't exist
    return [];
  }
}

/**
 * Load SKILL.md for a specific app.
 */
export async function loadAppSkill(appId: string): Promise<string | null> {
  try {
    const skillPath = join(APPS_DIR, appId, 'SKILL.md');
    const content = await readFile(skillPath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}

/**
 * Read a config file from an app.
 * For credentials.json, uses the centralized config/credentials/ location.
 * For other files, uses the app folder.
 */
export async function readAppConfig(
  appId: string,
  filename: string = 'credentials.json'
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
  content: unknown
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

export function registerAppsTools(server: McpServer): void {
  // apps_list - List available apps
  server.registerTool(
    'list',
    {
      description: 'List all available apps in the apps/ directory. Returns app ID, name, and whether it has SKILL.md and credentials.',
    },
    async () => {
      const apps = await listApps();

      if (apps.length === 0) {
        return ok('No apps found in apps/ directory.');
      }

      const lines = apps.map((app) => {
        const flags = [];
        if (app.hasSkill) flags.push('skill');
        if (app.hasCredentials) flags.push('credentials');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        return `- ${app.name} (${app.id})${flagStr}`;
      });

      return ok(`Available apps:\n${lines.join('\n')}`);
    }
  );

  // apps_load_skill - Load SKILL.md for an app
  server.registerTool(
    'load_skill',
    {
      description:
        'Load the SKILL.md file for a specific app. This contains instructions on how to use the app, including API endpoints, authentication, and available actions.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
      },
    },
    async (args) => {
      const skill = await loadAppSkill(args.appId);

      if (skill === null) {
        return ok(`Error: No SKILL.md found for app "${args.appId}". Use list to see available apps.`);
      }

      return ok(skill);
    }
  );

  // apps_read_config - Read app config file
  server.registerTool(
    'read_config',
    {
      description: 'Read a configuration file from an app. For credentials.json, reads from config/credentials/{appId}.json. Other files read from apps/{appId}/. Returns parsed JSON if valid, otherwise returns raw content.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
        filename: z.string().optional().describe('Config filename (default: credentials.json)'),
      },
    },
    async (args) => {
      const result = await readAppConfig(args.appId, args.filename);

      if (!result.success) {
        return ok(`Error: ${result.error}`);
      }

      // Format content based on type
      if (typeof result.content === 'object') {
        return ok(JSON.stringify(result.content, null, 2));
      }
      return ok(String(result.content));
    }
  );

  // apps_write_config - Write app config file
  server.registerTool(
    'write_config',
    {
      description: 'Write a configuration file for an app. For credentials.json, writes to config/credentials/{appId}.json. Other files write to apps/{appId}/. Content will be stored as JSON.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
        filename: z.string().describe('Config filename (e.g., credentials.json)'),
        content: z.record(z.string(), z.any()).describe('Content to write (will be JSON stringified)'),
      },
    },
    async (args) => {
      const result = await writeAppConfig(args.appId, args.filename, args.content);

      if (!result.success) {
        return ok(`Error: ${result.error}`);
      }

      return ok(`Successfully wrote ${args.filename} for app "${args.appId}".`);
    }
  );
}
