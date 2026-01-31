/**
 * Apps tools - discover and manage apps in the apps/ directory.
 *
 * Apps are convention-based folders containing:
 * - SKILL.md: Instructions for the AI on how to use the app
 * - credentials.json: (optional) API credentials for the app
 * - Other config files as needed
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, readFile, writeFile, stat, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ok } from '../utils.js';

// Compute apps directory from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const APPS_DIR = join(PROJECT_ROOT, 'apps');

export interface AppInfo {
  id: string;
  name: string;
  hasSkill: boolean;
  hasCredentials: boolean;
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

      // Check for credentials.json
      let hasCredentials = false;
      try {
        await stat(join(appPath, 'credentials.json'));
        hasCredentials = true;
      } catch {
        // File doesn't exist
      }

      // Convert kebab-case or snake_case to Title Case
      const name = appId
        .split(/[-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      apps.push({
        id: appId,
        name,
        hasSkill,
        hasCredentials,
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

    const configPath = join(APPS_DIR, appId, filename);
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

    const appPath = join(APPS_DIR, appId);
    const configPath = join(appPath, filename);

    // Ensure app directory exists
    await mkdir(appPath, { recursive: true });

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
    'apps_list',
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
    'apps_load_skill',
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
        return ok(`Error: No SKILL.md found for app "${args.appId}". Use apps_list to see available apps.`);
      }

      return ok(skill);
    }
  );

  // apps_read_config - Read app config file
  server.registerTool(
    'apps_read_config',
    {
      description: 'Read a configuration file from an app folder. Defaults to credentials.json. Returns parsed JSON if valid, otherwise returns raw content.',
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
    'apps_write_config',
    {
      description: 'Write a configuration file to an app folder. Content will be stored as JSON. Creates the app folder if it does not exist.',
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
