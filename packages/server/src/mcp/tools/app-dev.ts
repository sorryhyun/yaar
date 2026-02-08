/**
 * App development tools - write, compile, and deploy TypeScript apps.
 *
 * Workflow:
 * 1. write_ts - Write TypeScript code to a sandbox directory
 * 2. compile - Compile TypeScript to a bundled HTML file
 * 3. deploy - Deploy sandbox to apps/ directory as a desktop app
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, mkdir, cp, stat } from 'fs/promises';
import { join, dirname, normalize, relative } from 'path';
import { ok } from '../utils.js';
import { compileTypeScript, getSandboxPath } from '../../lib/compiler/index.js';
import { PROJECT_ROOT } from '../../config.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

/**
 * Validate path to prevent directory traversal.
 */
function isValidPath(basePath: string, targetPath: string): boolean {
  const normalizedTarget = normalize(join(basePath, targetPath));
  const relativePath = relative(basePath, normalizedTarget);
  return !relativePath.startsWith('..') && !relativePath.includes('..');
}

/**
 * Generate a sandbox ID using current timestamp.
 */
function generateSandboxId(): string {
  return Date.now().toString();
}

/**
 * Generate SKILL.md content for a deployed app.
 */
function generateSkillMd(appId: string, appName: string): string {
  return `# ${appName}

A compiled TypeScript application.

## Launch
Open this app in an iframe window:
\`\`\`
create({
  windowId: "${appId}",
  title: "${appName}",
  renderer: "iframe",
  content: "/api/apps/${appId}/static/index.html"
})
\`\`\`

## Source
Source code is available in \`src/\` directory. Use \`read_config\` with path \`src/main.ts\` to view.
`;
}

/**
 * Convert app ID to display name.
 * kebab-case or snake_case → Title Case
 */
function toDisplayName(appId: string): string {
  return appId
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function registerAppDevTools(server: McpServer): void {
  // app_write_ts - Write TypeScript to sandbox
  server.registerTool(
    'write_ts',
    {
      description: `Write TypeScript code to a sandbox directory. Creates a new sandbox if sandboxId is not provided. Use this to develop apps before compiling.

BUNDLED LIBRARIES - Available via @bundled/* imports (no npm install needed):
• @bundled/uuid - Unique ID generation: v4(), v1(), validate()
• @bundled/lodash - Utilities: debounce, throttle, cloneDeep, groupBy, sortBy, uniq, chunk, etc.
• @bundled/date-fns - Date utilities: format, addDays, differenceInDays, isToday, etc.
• @bundled/clsx - CSS class names: clsx('foo', { bar: true })
• @bundled/anime - Animation library: anime({ targets, translateX, duration, easing })
• @bundled/konva - 2D canvas graphics: Stage, Layer, Rect, Circle, Text, etc.

Example:
  import { v4 as uuid } from '@bundled/uuid';
  import anime from '@bundled/anime';
  import { format } from '@bundled/date-fns';`,
      inputSchema: {
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        content: z.string().describe('TypeScript source code'),
        sandboxId: z.string().optional().describe('Sandbox ID. If omitted, creates a new sandbox with timestamp ID.'),
      },
    },
    async (args) => {
      const { path, content, sandboxId: providedId } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return ok('Error: Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Create or use existing sandbox
      const sandboxId = providedId ?? generateSandboxId();
      const sandboxPath = getSandboxPath(sandboxId);

      // Validate the full path is within sandbox
      if (!isValidPath(sandboxPath, path)) {
        return ok('Error: Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      try {
        // Ensure parent directory exists
        await mkdir(dirname(fullPath), { recursive: true });

        // Write the file
        await writeFile(fullPath, content, 'utf-8');

        return ok(JSON.stringify({
          sandboxId,
          path,
          message: `File written to sandbox/${sandboxId}/${path}`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error: ${error}`);
      }
    }
  );

  // compile - Compile sandbox TypeScript to HTML
  server.registerTool(
    'compile',
    {
      description:
        'Compile TypeScript from a sandbox to a bundled HTML file. Entry point is src/main.ts. Returns a preview URL for viewing the app.',
      inputSchema: {
        sandbox: z.string().describe('Sandbox ID to compile'),
        entry: z.string().optional().describe('Entry file (default: src/main.ts) - not yet supported'),
        title: z.string().optional().describe('App title for HTML page (default: "App")'),
      },
    },
    async (args) => {
      const { sandbox: sandboxId, title } = args;

      // Validate sandbox ID (must be numeric timestamp)
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      // Check sandbox exists
      try {
        await stat(sandboxPath);
      } catch {
        return ok(`Error: Sandbox "${sandboxId}" not found.`);
      }

      // Compile
      const result = await compileTypeScript(sandboxPath, { title });

      if (!result.success) {
        return ok(`Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`);
      }

      const previewUrl = `/api/sandbox/${sandboxId}/dist/index.html`;

      return ok(JSON.stringify({
        success: true,
        previewUrl,
        message: 'Compilation successful. Use create with renderer: "iframe" to preview.',
      }, null, 2));
    }
  );

  // app_deploy - Deploy sandbox to apps/ directory
  server.registerTool(
    'deploy',
    {
      description:
        'Deploy a compiled sandbox as a desktop app. Creates the app folder in apps/, copies files, and generates SKILL.md so the app appears on the desktop.',
      inputSchema: {
        sandbox: z.string().describe('Sandbox ID to deploy'),
        appId: z.string().describe('App ID (becomes folder name in apps/). Use lowercase with hyphens.'),
        name: z.string().optional().describe('Display name (defaults to title-cased appId)'),
        icon: z.string().optional().describe('Emoji icon (default: "🎮")'),
        keepSource: z.boolean().optional().describe('Include src/ in deployed app (default: true)'),
      },
    },
    async (args) => {
      const {
        sandbox: sandboxId,
        appId,
        name,
        icon = '🎮',
        keepSource = true,
      } = args;

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      // Validate app ID (lowercase, hyphens allowed, no special chars)
      if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
        return ok('Error: Invalid app ID. Use lowercase letters, numbers, and hyphens. Must start with a letter.');
      }

      const sandboxPath = getSandboxPath(sandboxId);
      const appPath = join(APPS_DIR, appId);

      // Check sandbox exists
      try {
        await stat(sandboxPath);
      } catch {
        return ok(`Error: Sandbox "${sandboxId}" not found.`);
      }

      // Check dist/index.html exists (must be compiled first)
      const distIndexPath = join(sandboxPath, 'dist', 'index.html');
      try {
        await stat(distIndexPath);
      } catch {
        return ok('Error: No compiled output found. Run compile first.');
      }

      const displayName = name ?? toDisplayName(appId);

      try {
        // Create app directory
        await mkdir(appPath, { recursive: true });

        // Copy dist/index.html to app root
        await cp(distIndexPath, join(appPath, 'index.html'));

        // Optionally copy source
        if (keepSource) {
          const srcPath = join(sandboxPath, 'src');
          try {
            await stat(srcPath);
            await cp(srcPath, join(appPath, 'src'), { recursive: true });
          } catch {
            // No src directory, skip
          }
        }

        // Generate SKILL.md
        const skillContent = generateSkillMd(appId, displayName);
        await writeFile(join(appPath, 'SKILL.md'), skillContent, 'utf-8');

        // Write app metadata (icon, etc.)
        const metadata = { icon, name: displayName };
        await writeFile(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2), 'utf-8');

        // Optionally clean up sandbox
        // await rm(sandboxPath, { recursive: true, force: true });

        return ok(JSON.stringify({
          success: true,
          appId,
          name: displayName,
          icon,
          message: `App "${displayName}" deployed! It will appear on the desktop.`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error deploying app: ${error}`);
      }
    }
  );
}
