/**
 * App development tools - write, compile, and deploy TypeScript apps.
 *
 * Workflow (new app):
 * 1. write_ts - Write TypeScript code to a sandbox directory
 * 2. compile - Compile TypeScript to a bundled HTML file
 * 3. deploy - Deploy sandbox to apps/ directory as a desktop app
 *
 * Workflow (revise existing app):
 * 1. clone - Clone deployed app source into a new sandbox
 * 2. apply_diff_ts / write_ts - Modify files in the sandbox
 * 3. compile - Recompile
 * 4. deploy - Redeploy (same appId overwrites)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'fs/promises';
import { join, dirname, normalize, relative } from 'path';
import { ok } from '../utils.js';
import { compileTypeScript, getSandboxPath } from '../../lib/compiler/index.js';
import { PROJECT_ROOT } from '../../config.js';
import { actionEmitter } from '../action-emitter.js';
import { componentLayoutSchema } from '@yaar/shared';

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
function generateSkillMd(appId: string, appName: string, componentFiles: string[] = []): string {
  let md = `# ${appName}

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
`;

  if (componentFiles.length > 0) {
    md += `\n## UI Components\nPre-built component windows (use create_component with jsonfile):\n`;
    for (const f of componentFiles) {
      md += `- \`create_component(jsonfile="${appId}/${f}", windowId="...", title="...")\`\n`;
    }
  }

  md += `\n## Source
Source code is available in \`src/\` directory. Use \`read_config\` with path \`src/main.ts\` to view.
`;
  return md;
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
      description: `Write TypeScript code to a sandbox directory. Creates a new sandbox if sandboxId is not provided. Use this to develop apps before compiling. Entry point is src/main.ts. Split code into multiple files (e.g., src/utils.ts, src/renderer.ts) and import them from main.ts — avoid putting everything in one file.

BUNDLED LIBRARIES - Available via @bundled/* imports (no npm install needed):
• @bundled/uuid - Unique ID generation: v4(), v1(), validate()
• @bundled/lodash - Utilities: debounce, throttle, cloneDeep, groupBy, sortBy, uniq, chunk, etc.
• @bundled/date-fns - Date utilities: format, addDays, differenceInDays, isToday, etc.
• @bundled/clsx - CSS class names: clsx('foo', { bar: true })
• @bundled/anime - Animation library: anime({ targets, translateX, duration, easing })
• @bundled/konva - 2D canvas graphics: Stage, Layer, Rect, Circle, Text, etc.

STORAGE API - Available at runtime via window.yaar.storage (auto-injected, no import needed):
• save(path, data) - Write file (string | Blob | ArrayBuffer | Uint8Array)
• read(path, opts?) - Read file (opts.as: 'text'|'blob'|'arraybuffer'|'json'|'auto')
• list(dirPath?) - List directory → [{path, isDirectory, size, modifiedAt}]
• remove(path) - Delete file
• url(path) - Get URL string for <a>/<img>/etc.
Files are stored in the server's storage/ directory. Paths are relative (e.g., "myapp/data.json").

Example:
  import { v4 as uuid } from '@bundled/uuid';
  import anime from '@bundled/anime';
  import { format } from '@bundled/date-fns';
  // Storage (global, no import):
  // await yaar.storage.save('scores.json', JSON.stringify(data));
  // const data = await yaar.storage.read('scores.json', { as: 'json' });`,
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

        // Copy .yaarcomponent.json files from sandbox root
        const componentFiles: string[] = [];
        try {
          const sandboxFiles = await readdir(sandboxPath);
          for (const f of sandboxFiles) {
            if (f.endsWith('.yaarcomponent.json')) {
              await cp(join(sandboxPath, f), join(appPath, f));
              componentFiles.push(f);
            }
          }
        } catch {
          // readdir failure is non-fatal
        }

        // Generate SKILL.md
        const skillContent = generateSkillMd(appId, displayName, componentFiles);
        await writeFile(join(appPath, 'SKILL.md'), skillContent, 'utf-8');

        // Write app metadata (icon, etc.)
        const metadata = { icon, name: displayName };
        await writeFile(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2), 'utf-8');

        // Notify frontend to refresh desktop app icons
        actionEmitter.emitAction({ type: 'desktop.refreshApps' });

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

  // clone - Clone deployed app source into a sandbox for editing
  server.registerTool(
    'clone',
    {
      description:
        'Clone an existing deployed app\'s source into a new sandbox for editing. Use write_ts or apply_diff_ts to modify, then compile and deploy to update the app.',
      inputSchema: {
        appId: z.string().describe('The app ID to clone (folder name in apps/)'),
      },
    },
    async (args) => {
      const { appId } = args;

      // Validate app ID
      if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
        return ok('Error: Invalid app ID.');
      }

      const appPath = join(APPS_DIR, appId);
      const appSrcPath = join(appPath, 'src');

      // Check app and source exist
      try {
        await stat(appSrcPath);
      } catch {
        return ok(`Error: No source found for app "${appId}". Only apps deployed with keepSource can be cloned.`);
      }

      const sandboxId = generateSandboxId();
      const sandboxPath = getSandboxPath(sandboxId);

      try {
        await mkdir(join(sandboxPath, 'src'), { recursive: true });
        await cp(appSrcPath, join(sandboxPath, 'src'), { recursive: true });

        // List cloned files with sandbox-relative paths (prefixed with src/)
        const files = await readdir(appSrcPath, { recursive: true });
        const fileList = (files as string[])
          .filter((f) => !f.includes('node_modules'))
          .map((f) => `src/${f}`);

        return ok(JSON.stringify({
          sandboxId,
          appId,
          files: fileList,
          message: `Cloned "${appId}" source into sandbox ${sandboxId}. Files are under src/. Use paths like "src/main.ts" with write_ts or apply_diff_ts, then compile and deploy. Prefer splitting code into separate files (e.g., src/utils.ts, src/components.ts) and importing them from src/main.ts rather than putting everything in one file.`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error cloning app: ${error}`);
      }
    }
  );

  // apply_diff_ts - Apply search-and-replace edit to a sandbox file
  server.registerTool(
    'apply_diff_ts',
    {
      description:
        'Apply a search-and-replace edit to an existing file in a sandbox. Finds the exact old_string and replaces it with new_string. Use this to revise code without rewriting the entire file.',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID containing the file'),
        path: z.string().describe('Relative path in sandbox (e.g., "src/main.ts")'),
        old_string: z.string().describe('The exact text to find (must be unique in the file)'),
        new_string: z.string().describe('The replacement text'),
      },
    },
    async (args) => {
      const { sandboxId, path, old_string, new_string } = args;

      // Validate path
      if (path.includes('..') || path.startsWith('/')) {
        return ok('Error: Invalid path. Use relative paths without ".." or leading "/".');
      }

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const sandboxPath = getSandboxPath(sandboxId);

      if (!isValidPath(sandboxPath, path)) {
        return ok('Error: Path escapes sandbox directory.');
      }

      const fullPath = join(sandboxPath, path);

      // Read existing content
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        return ok(`Error: File not found: ${path}`);
      }

      // Check old_string exists
      if (!content.includes(old_string)) {
        return ok('Error: old_string not found in file. Make sure it matches exactly (including whitespace).');
      }

      // Check uniqueness
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        return ok(`Error: old_string found ${count} times. Provide more surrounding context to make it unique.`);
      }

      // Apply replacement
      const newContent = content.replace(old_string, new_string);
      await writeFile(fullPath, newContent, 'utf-8');

      return ok(JSON.stringify({
        sandboxId,
        path,
        message: `Applied edit to sandbox/${sandboxId}/${path}`,
      }, null, 2));
    }
  );

  // compile_component - Write a .yaarcomponent.json file to sandbox
  server.registerTool(
    'compile_component',
    {
      description:
        'Create a .yaarcomponent.json file in a sandbox. This lets you define reusable component window layouts that get deployed alongside the app. After deploy, the AI can load them via create_component(jsonfile="{appId}/{filename}").',
      inputSchema: {
        sandboxId: z.string().describe('Sandbox ID to write the component file into'),
        filename: z.string().describe('Filename (e.g., "dashboard.yaarcomponent.json"). Must end with .yaarcomponent.json.'),
        components: z.array(z.record(z.string(), z.unknown())).describe('Flat array of UI components (same format as create_component)'),
        cols: z.union([z.array(z.number()), z.number()]).optional().describe('Column layout'),
        gap: z.enum(['none', 'sm', 'md', 'lg']).optional().describe('Spacing between components'),
      },
    },
    async (args) => {
      const { sandboxId, filename } = args;

      if (!filename.endsWith('.yaarcomponent.json')) {
        return ok('Error: Filename must end with .yaarcomponent.json');
      }
      if (filename.includes('/') || filename.includes('..')) {
        return ok('Error: Filename must not contain path separators.');
      }
      if (!/^\d+$/.test(sandboxId)) {
        return ok('Error: Invalid sandbox ID. Must be a numeric timestamp.');
      }

      const layout = {
        components: args.components,
        ...(args.cols !== undefined && { cols: args.cols }),
        ...(args.gap !== undefined && { gap: args.gap }),
      };

      // Validate against component layout schema
      const result = componentLayoutSchema.safeParse(layout);
      if (!result.success) {
        return ok(`Error: Invalid component layout: ${result.error.message}`);
      }

      const sandboxPath = getSandboxPath(sandboxId);
      const fullPath = join(sandboxPath, filename);

      try {
        await mkdir(sandboxPath, { recursive: true });
        await writeFile(fullPath, JSON.stringify(result.data, null, 2), 'utf-8');

        return ok(JSON.stringify({
          sandboxId,
          filename,
          message: `Component file written to sandbox/${sandboxId}/${filename}. It will be deployed alongside the app.`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error: ${error}`);
      }
    }
  );
}
