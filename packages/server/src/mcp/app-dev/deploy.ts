/**
 * App development deploy tools - deploy, clone, write_json.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, mkdir, cp, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { ok } from '../utils.js';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { PROJECT_ROOT } from '../../config.js';
import { actionEmitter } from '../action-emitter.js';
import { componentLayoutSchema } from '@yaar/shared';
import { toDisplayName, generateSandboxId, generateSkillMd, regenerateSkillMd } from './helpers.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

export function registerDeployTools(server: McpServer): void {
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
        skill: z.string().optional().describe('Custom SKILL.md content. The ## Launch section with correct iframe URL will be auto-appended. Write app-specific instructions, usage guides, etc.'),
      },
    },
    async (args) => {
      const {
        sandbox: sandboxId,
        appId,
        name,
        icon = '🎮',
        keepSource = true,
        skill,
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

      // Check for compiled output (index.html) or component files
      const distIndexPath = join(sandboxPath, 'dist', 'index.html');
      let hasCompiledApp = false;
      try {
        await stat(distIndexPath);
        hasCompiledApp = true;
      } catch {
        // No compiled output
      }

      // Scan for component files early to validate we have something to deploy
      const componentFiles: string[] = [];
      try {
        const sandboxFiles = await readdir(sandboxPath);
        for (const f of sandboxFiles) {
          if (f.endsWith('.yaarcomponent.json')) {
            componentFiles.push(f);
          }
        }
      } catch {
        // readdir failure is non-fatal
      }

      if (!hasCompiledApp && componentFiles.length === 0) {
        return ok('Error: Nothing to deploy. Run compile first or create component files with compile_component.');
      }

      const displayName = name ?? toDisplayName(appId);

      try {
        // Clean existing app content before deploying (remove stale files)
        try {
          await stat(appPath);
          // Remove src/ and index.html so stale files don't linger
          await rm(join(appPath, 'src'), { recursive: true, force: true });
          await rm(join(appPath, 'index.html'), { force: true });
        } catch {
          // App doesn't exist yet, nothing to clean
        }

        // Create app directory
        await mkdir(appPath, { recursive: true });

        // Copy dist/index.html to app root (if compiled)
        if (hasCompiledApp) {
          await cp(distIndexPath, join(appPath, 'index.html'));
        }

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

        // Copy .yaarcomponent.json files from sandbox to app
        for (const f of componentFiles) {
          await cp(join(sandboxPath, f), join(appPath, f));
        }

        // Generate SKILL.md
        const skillContent = generateSkillMd(appId, displayName, hasCompiledApp, componentFiles, skill);
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
        'Clone an existing deployed app\'s source into a sandbox for editing. Use write_ts or apply_diff_ts to modify, then compile and deploy back to the SAME appId to update the app in-place.',
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
          message: `Cloned "${appId}" source into sandbox ${sandboxId}. Files are under src/. Use paths like "src/main.ts" with write_ts or apply_diff_ts, then compile and deploy back to appId="${appId}" to update the app in-place. Prefer splitting code into separate files (e.g., src/utils.ts, src/components.ts) and importing them from src/main.ts rather than putting everything in one file.`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error cloning app: ${error}`);
      }
    }
  );

  // write_json - Write a JSON file directly to a deployed app
  server.registerTool(
    'write_json',
    {
      description:
        'Write a JSON file directly to a deployed app directory. Use this for .yaarcomponent.json files or other JSON data. For .yaarcomponent.json files, content is validated against the component layout schema. Also regenerates SKILL.md to include the new component in the Launch section.',
      inputSchema: {
        appId: z.string().describe('The app ID (folder name in apps/)'),
        filename: z.string().describe('Filename (e.g., "dashboard.yaarcomponent.json")'),
        content: z.record(z.string(), z.unknown()).describe('JSON content to write'),
      },
    },
    async (args) => {
      const { appId, filename, content } = args;

      // Validate app ID
      if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
        return ok('Error: Invalid app ID.');
      }

      // Validate filename
      if (filename.includes('/') || filename.includes('..')) {
        return ok('Error: Filename must not contain path separators.');
      }

      const appPath = join(APPS_DIR, appId);

      // Check app exists
      try {
        await stat(appPath);
      } catch {
        return ok(`Error: App "${appId}" not found. Deploy it first.`);
      }

      // Validate against component schema if it's a component file
      if (filename.endsWith('.yaarcomponent.json')) {
        const result = componentLayoutSchema.safeParse(content);
        if (!result.success) {
          return ok(`Error: Invalid component layout: ${result.error.message}`);
        }
      }

      try {
        await writeFile(join(appPath, filename), JSON.stringify(content, null, 2), 'utf-8');

        // Regenerate SKILL.md if a component file was added
        if (filename.endsWith('.yaarcomponent.json')) {
          await regenerateSkillMd(appId, appPath);
        }

        return ok(JSON.stringify({
          appId,
          filename,
          message: `Written ${filename} to apps/${appId}/`,
        }, null, 2));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        return ok(`Error: ${error}`);
      }
    }
  );
}
