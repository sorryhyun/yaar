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
import { parseFileUri } from '@yaar/shared';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

// ── Core deploy/clone logic (reusable from verb layer) ──

export interface DeployArgs {
  appId: string;
  name?: string;
  description?: string;
  icon?: string;
  createShortcut?: boolean;
  keepSource?: boolean;
  skill?: string;
  appProtocol?: boolean;
  version?: string;
  author?: string;
  fileAssociations?: Array<{ extensions: string[]; command: string; paramKey: string }>;
  variant?: 'standard' | 'widget' | 'panel';
  dockEdge?: 'top' | 'bottom';
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  capture?: 'auto' | 'canvas' | 'dom' | 'svg' | 'protocol';
}

export interface DeployResult {
  success: true;
  appId: string;
  name: string;
  icon: string;
}

export async function doDeploy(
  sandboxId: string,
  args: DeployArgs,
): Promise<DeployResult | { success: false; error: string }> {
  const {
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

  if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
    return {
      success: false,
      error:
        'Invalid app ID. Use lowercase letters, numbers, and hyphens. Must start with a letter.',
    };
  }

  const sandboxPath = getSandboxPath(sandboxId);
  const appPath = join(APPS_DIR, appId);

  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }

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
    try {
      await stat(join(sandboxPath, 'src', 'main.ts'));
      const compileResult = await compileTypeScript(sandboxPath, {
        title: name ?? toDisplayName(appId),
      });
      if (!compileResult.success) {
        return {
          success: false,
          error: `Auto-compile failed:\n${compileResult.errors?.join('\n') ?? 'Unknown error'}`,
        };
      }
      const distHtml = await Bun.file(distIndexPath).text();
      hasCompiledApp = true;
      if (explicitAppProtocol === undefined) {
        hasAppProtocol = distHtml.includes('.app.register');
      }
    } catch {
      // No source either
    }
  }

  try {
    const protocolJson = await Bun.file(join(sandboxPath, 'dist', 'protocol.json')).text();
    extractedProtocol = JSON.parse(protocolJson);
  } catch {
    // No protocol extracted
  }

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
    return { success: false, error: 'Nothing to deploy. Run compile first.' };
  }

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
    try {
      await stat(appPath);
      await rm(join(appPath, 'src'), { recursive: true, force: true });
      await rm(join(appPath, 'index.html'), { force: true });
    } catch {
      // App doesn't exist yet
    }

    await mkdir(appPath, { recursive: true });

    if (hasCompiledApp) {
      await cp(distIndexPath, join(appPath, 'index.html'));
    }

    if (keepSource) {
      const srcPath = join(sandboxPath, 'src');
      try {
        await stat(srcPath);
        await cp(srcPath, join(appPath, 'src'), { recursive: true });
      } catch {
        // No src directory
      }
    }

    for (const f of componentFiles) {
      await cp(join(sandboxPath, f), join(appPath, f));
    }

    const skillContent = generateSkillMd(
      appId,
      displayName,
      hasCompiledApp,
      componentFiles,
      skill,
      hasAppProtocol,
    );
    await Bun.write(join(appPath, 'SKILL.md'), skillContent);

    const metadata: Record<string, unknown> = { ...existingMeta };
    metadata.icon = resolvedIcon;
    metadata.name = displayName;
    if (description !== undefined) metadata.description = description;
    if (hasCompiledApp) metadata.run = 'index.html';
    if (createShortcut !== undefined) {
      if (createShortcut === false) metadata.createShortcut = false;
      else delete metadata.createShortcut;
    }
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
    if (extractedProtocol) {
      metadata.protocol = extractedProtocol;
    } else if (!hasAppProtocol) {
      delete metadata.protocol;
    }
    await Bun.write(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2) + '\n');

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

    actionEmitter.emitAction({ type: 'desktop.refreshApps' });

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
      const removed = await removeAppShortcut(appId);
      if (removed) {
        actionEmitter.emitAction({
          type: 'desktop.removeShortcut',
          shortcutId: `app-${appId}`,
        });
      }
    }

    return { success: true, appId, name: displayName, icon: resolvedIcon };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Failed to deploy app: ${msg}` };
  }
}

export interface CloneResult {
  success: true;
  sandboxId: string;
  appId: string;
  files: string[];
}

export async function doClone(
  appId: string,
): Promise<CloneResult | { success: false; error: string }> {
  if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
    return { success: false, error: 'Invalid app ID.' };
  }

  const appPath = join(APPS_DIR, appId);
  const appSrcPath = join(appPath, 'src');

  try {
    await stat(appSrcPath);
  } catch {
    return {
      success: false,
      error: `No source found for app "${appId}". Only apps deployed with keepSource can be cloned.`,
    };
  }

  const sandboxId = generateSandboxId();
  const sandboxPath = getSandboxPath(sandboxId);

  try {
    await mkdir(join(sandboxPath, 'src'), { recursive: true });
    await cp(appSrcPath, join(sandboxPath, 'src'), { recursive: true });

    const files = await readdir(appSrcPath, { recursive: true });
    const fileList = (files as string[])
      .filter((f) => !f.includes('node_modules'))
      .map((f) => `src/${f}`);

    return { success: true, sandboxId, appId, files: fileList };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Failed to clone app: ${msg}` };
  }
}

export function registerDeployTools(server: McpServer): void {
  // app_deploy - Deploy sandbox to apps/ directory
  server.registerTool(
    'deploy',
    {
      description: 'Deploy a sandbox as a desktop app. Auto-compiles if not already compiled.',
      inputSchema: {
        uri: z.string(),
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
      const parsed = parseFileUri(args.uri);
      if (!parsed || parsed.authority !== 'sandbox' || !parsed.sandboxId) {
        return error('Expected a sandbox URI (e.g. yaar://sandbox/123).');
      }
      const result = await doDeploy(parsed.sandboxId, args);
      if (!result.success) return error(result.error);
      return ok(
        JSON.stringify(
          {
            success: true,
            appId: result.appId,
            name: result.name,
            icon: result.icon,
            message: `App "${result.name}" deployed! It will appear on the desktop.`,
          },
          null,
          2,
        ),
      );
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
      const result = await doClone(args.appId);
      if (!result.success) return error(result.error);
      return ok(
        JSON.stringify(
          {
            sandboxId: result.sandboxId,
            appId: result.appId,
            files: result.files,
            message: `Cloned "${result.appId}" source into sandbox ${result.sandboxId}. Files are under src/. Use paths like "yaar://sandbox/${result.sandboxId}/src/main.ts" with write or edit, then compile and deploy back to appId="${result.appId}" to update the app in-place. Prefer splitting code into separate files (e.g., src/utils.ts, src/components.ts) and importing them from src/main.ts rather than putting everything in one file.`,
          },
          null,
          2,
        ),
      );
    },
  );
}
