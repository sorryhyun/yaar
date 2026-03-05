/**
 * App development deploy tools - deploy, clone.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdir, cp, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { ok, error } from '../utils.js';
import { compileTypeScript, getSandboxPath } from '../../lib/compiler/index.js';
import { PROJECT_ROOT } from '../../config.js';
import { actionEmitter } from '../action-emitter.js';
import { type AppManifest, buildYaarUri } from '@yaar/shared';
import { toDisplayName, generateSandboxId, generateSkillMd } from './helpers.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

export function registerDeployTools(server: McpServer): void {
  // app_deploy - Deploy sandbox to apps/ directory
  server.registerTool(
    'deploy',
    {
      description: 'Deploy a sandbox as a desktop app. Auto-compiles if not already compiled.',
      inputSchema: {
        sandbox: z.string().describe('Sandbox ID to deploy'),
        appId: z.string().describe('App ID (lowercase with hyphens)'),
        name: z.string().optional().describe('Display name'),
        description: z.string().optional().describe('Brief description of what the app does'),
        icon: z.string().optional().describe('Emoji icon'),
        createShortcut: z
          .boolean()
          .optional()
          .describe('Create desktop shortcut on deploy (default: true)'),
        keepSource: z.boolean().optional().describe('Include src/ in deployed app'),
        skill: z.string().optional().describe('Custom SKILL.md content (## Launch auto-appended)'),
        appProtocol: z
          .boolean()
          .optional()
          .describe('App Protocol support (auto-detected if omitted)'),
        version: z
          .string()
          .optional()
          .describe('Semantic version (e.g., "1.0.0"). Defaults to "1.0.0"'),
        author: z.string().optional().describe('Author name. Defaults to "YAAR"'),
        fileAssociations: z
          .array(
            z.object({
              extensions: z.array(z.string()),
              command: z.string(),
              paramKey: z.string(),
            }),
          )
          .optional()
          .describe('File types this app can open'),
        variant: z.enum(['standard', 'widget', 'panel']).optional().describe('Window variant type'),
        dockEdge: z.enum(['top', 'bottom']).optional().describe('Dock edge position'),
        frameless: z.boolean().optional().describe('Frameless window (no title bar)'),
        windowStyle: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Custom CSS properties for the window'),
        capture: z
          .enum(['auto', 'canvas', 'dom', 'svg', 'protocol'])
          .optional()
          .describe(
            'Screenshot capture strategy: canvas (toDataURL on largest canvas), dom (html2canvas), svg (serialize largest SVG), protocol (app provides its own screenshot), auto (default fallback chain)',
          ),
      },
    },
    async (args) => {
      const {
        sandbox: sandboxId,
        appId,
        name,
        description,
        icon,
        createShortcut,
        keepSource = true,
        skill,
        appProtocol: explicitAppProtocol,
        version,
        author,
        fileAssociations,
        variant,
        dockEdge,
        frameless,
        windowStyle,
        capture,
      } = args;

      // Validate sandbox ID
      if (!/^\d+$/.test(sandboxId)) {
        return error('Invalid sandbox ID. Must be a numeric timestamp.');
      }

      // Validate app ID (lowercase, hyphens allowed, no special chars)
      if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
        return error(
          'Invalid app ID. Use lowercase letters, numbers, and hyphens. Must start with a letter.',
        );
      }

      const sandboxPath = getSandboxPath(sandboxId);
      const appPath = join(APPS_DIR, appId);

      // Check sandbox exists
      try {
        await stat(sandboxPath);
      } catch {
        return error(`Sandbox "${sandboxId}" not found.`);
      }

      // Check for compiled output (index.html) or auto-compile if source exists
      const distIndexPath = join(sandboxPath, 'dist', 'index.html');
      let hasCompiledApp = false;
      let hasAppProtocol = explicitAppProtocol ?? false;
      let extractedProtocol: Pick<AppManifest, 'state' | 'commands'> | null = null;
      try {
        const distHtml = await Bun.file(distIndexPath).text();
        hasCompiledApp = true;
        if (explicitAppProtocol === undefined) {
          hasAppProtocol = distHtml.includes('.app.register');
        }
      } catch {
        // No compiled output — auto-compile if src/main.ts exists
        try {
          await stat(join(sandboxPath, 'src', 'main.ts'));
          const compileResult = await compileTypeScript(sandboxPath, {
            title: name ?? toDisplayName(appId),
          });
          if (!compileResult.success) {
            return error(
              `Auto-compile failed:\n${compileResult.errors?.join('\n') ?? 'Unknown error'}`,
            );
          }
          const distHtml = await Bun.file(distIndexPath).text();
          hasCompiledApp = true;
          if (explicitAppProtocol === undefined) {
            hasAppProtocol = distHtml.includes('.app.register');
          }
        } catch {
          // No source either — will check for component files below
        }
      }
      // Read protocol manifest emitted by compiler (dist/protocol.json)
      try {
        const protocolJson = await Bun.file(join(sandboxPath, 'dist', 'protocol.json')).text();
        extractedProtocol = JSON.parse(protocolJson);
      } catch {
        // No protocol extracted — app may not use App Protocol
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
        return error('Nothing to deploy. Run compile first.');
      }

      // Read existing app.json and manifest.json for merging (preserves fields not in deploy args)
      let existingMeta: Record<string, unknown> = {};
      let existingManifest: Record<string, unknown> = {};
      try {
        existingMeta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
      } catch {
        // New app
      }
      try {
        existingManifest = JSON.parse(await Bun.file(join(appPath, 'manifest.json')).text());
      } catch {
        // New app
      }

      const resolvedIcon = icon ?? (existingMeta.icon as string | undefined) ?? '🎮';
      const displayName = name ?? (existingMeta.name as string | undefined) ?? toDisplayName(appId);

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
        const skillContent = generateSkillMd(
          appId,
          displayName,
          hasCompiledApp,
          componentFiles,
          skill,
          hasAppProtocol,
        );
        await Bun.write(join(appPath, 'SKILL.md'), skillContent);

        // Merge app metadata: preserve existing fields, override only what was explicitly provided
        const metadata: Record<string, unknown> = { ...existingMeta };
        metadata.icon = resolvedIcon;
        metadata.name = displayName;
        if (description !== undefined) metadata.description = description;
        if (hasCompiledApp) metadata.run = 'index.html';
        if (createShortcut !== undefined) {
          if (createShortcut === false) metadata.createShortcut = false;
          else delete metadata.createShortcut;
        }
        // Clean up old hidden field
        delete metadata.hidden;
        if (explicitAppProtocol !== undefined) {
          if (explicitAppProtocol) metadata.appProtocol = true;
          else delete metadata.appProtocol;
        } else if (hasAppProtocol) {
          metadata.appProtocol = true;
        }
        if (fileAssociations !== undefined) {
          if (fileAssociations.length > 0) metadata.fileAssociations = fileAssociations;
          else delete metadata.fileAssociations;
        }
        if (variant !== undefined) {
          if (variant !== 'standard') metadata.variant = variant;
          else delete metadata.variant;
        }
        if (dockEdge !== undefined) metadata.dockEdge = dockEdge;
        if (frameless !== undefined) {
          if (frameless) metadata.frameless = true;
          else delete metadata.frameless;
        }
        if (windowStyle !== undefined) metadata.windowStyle = windowStyle;
        if (capture !== undefined) {
          if (capture !== 'auto') metadata.capture = capture;
          else delete metadata.capture;
        }
        // Write extracted protocol manifest (or clear it if app no longer has protocol)
        if (extractedProtocol) {
          metadata.protocol = extractedProtocol;
        } else if (!hasAppProtocol) {
          delete metadata.protocol;
        }
        await Bun.write(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2) + '\n');

        // Merge marketplace manifest: preserve existing fields, override only what was provided
        const manifest: Record<string, unknown> = {
          ...existingManifest,
          id: appId,
          name: displayName,
          icon: resolvedIcon,
        };
        if (description !== undefined) manifest.description = description;
        else if (!manifest.description) manifest.description = '';
        if (version !== undefined) manifest.version = version;
        else if (!manifest.version) manifest.version = '1.0.0';
        if (author !== undefined) manifest.author = author;
        else if (!manifest.author) manifest.author = 'YAAR';
        await Bun.write(join(appPath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

        // Notify frontend to refresh desktop app icons
        actionEmitter.emitAction({ type: 'desktop.refreshApps' });

        // Manage desktop shortcut
        if (createShortcut !== false) {
          await ensureAppShortcut({
            id: appId,
            name: displayName,
            icon: resolvedIcon,
            iconType: 'emoji',
          });
          actionEmitter.emitAction({
            type: 'desktop.createShortcut',
            shortcut: {
              id: `app-${appId}`,
              label: displayName,
              icon: resolvedIcon,
              target: buildYaarUri('apps', appId),
              createdAt: Date.now(),
            },
          });
        } else {
          // Remove existing shortcut if createShortcut is explicitly false
          const removed = await removeAppShortcut(appId);
          if (removed) {
            actionEmitter.emitAction({
              type: 'desktop.removeShortcut',
              shortcutId: `app-${appId}`,
            });
          }
        }

        return ok(
          JSON.stringify(
            {
              success: true,
              appId,
              name: displayName,
              icon: resolvedIcon,
              message: `App "${displayName}" deployed! It will appear on the desktop.`,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return error(`Failed to deploy app: ${msg}`);
      }
    },
  );

  // clone - Clone deployed app source into a sandbox for editing
  server.registerTool(
    'clone',
    {
      description:
        "Clone an existing deployed app's source into a sandbox for editing. Use write or edit to modify, then compile and deploy back to the SAME appId to update the app in-place.",
      inputSchema: {
        appId: z.string().describe('The app ID to clone (folder name in apps/)'),
      },
    },
    async (args) => {
      const { appId } = args;

      // Validate app ID
      if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
        return error('Invalid app ID.');
      }

      const appPath = join(APPS_DIR, appId);
      const appSrcPath = join(appPath, 'src');

      // Check app and source exist
      try {
        await stat(appSrcPath);
      } catch {
        return error(
          `No source found for app "${appId}". Only apps deployed with keepSource can be cloned.`,
        );
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

        return ok(
          JSON.stringify(
            {
              sandboxId,
              appId,
              files: fileList,
              message: `Cloned "${appId}" source into sandbox ${sandboxId}. Files are under src/. Use paths like "yaar://sandbox/${sandboxId}/src/main.ts" with write or edit, then compile and deploy back to appId="${appId}" to update the app in-place. Prefer splitting code into separate files (e.g., src/utils.ts, src/components.ts) and importing them from src/main.ts rather than putting everything in one file.`,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return error(`Failed to clone app: ${msg}`);
      }
    },
  );
}
