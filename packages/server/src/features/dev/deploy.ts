/**
 * App development deploy logic.
 */

import { mkdir, cp, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { compileTypeScript, getSandboxPath, extractProtocolFromSource } from '@yaar/compiler';
import { PROJECT_ROOT } from '../../config.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { type AppManifest, buildYaarUri } from '@yaar/shared';
import { toDisplayName, generateSkillMd } from './helpers.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

export interface DeployArgs {
  appId: string;
  name?: string;
  description?: string;
  icon?: string;
  keepSource?: boolean;
  skill?: string;
  sourcePath?: string; // Override sandbox path — use this directory as source
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
  const { appId, name, description, icon, keepSource = true, skill } = args;

  if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
    return {
      success: false,
      error:
        'Invalid app ID. Use lowercase letters, numbers, and hyphens. Must start with a letter.',
    };
  }

  const sandboxPath = args.sourcePath ?? getSandboxPath(sandboxId);
  const appPath = join(APPS_DIR, appId);

  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }

  const distIndexPath = join(sandboxPath, 'dist', 'index.html');
  let hasCompiledApp = false;
  let extractedProtocol: Pick<AppManifest, 'state' | 'commands'> | null = null;
  try {
    await Bun.file(distIndexPath).text();
    hasCompiledApp = true;
  } catch {
    try {
      await stat(join(sandboxPath, 'src', 'main.ts'));
      // Read bundles from app.json if present (gates @bundled/yaar-* imports)
      let bundles: string[] | undefined;
      try {
        const appMeta = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
        if (Array.isArray(appMeta.bundles)) bundles = appMeta.bundles;
      } catch {
        /* no app.json */
      }
      const compileResult = await compileTypeScript(sandboxPath, {
        title: name ?? toDisplayName(appId),
        bundles,
      });
      if (!compileResult.success) {
        return {
          success: false,
          error: `Auto-compile failed:\n${compileResult.errors?.join('\n') ?? 'Unknown error'}`,
        };
      }
      hasCompiledApp = true;
    } catch {
      // No source either
    }
  }

  try {
    const protocolJson = await Bun.file(join(sandboxPath, 'dist', 'protocol.json')).text();
    extractedProtocol = JSON.parse(protocolJson);
  } catch {
    // No dist/protocol.json — try extracting directly from source files
    for (const file of ['main.ts', 'protocol.ts']) {
      try {
        const source = await Bun.file(join(sandboxPath, 'src', file)).text();
        const protocol = extractProtocolFromSource(source);
        if (protocol) {
          extractedProtocol = protocol;
          break;
        }
      } catch {
        continue;
      }
    }
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

  // Read SKILL.md from sandbox if it exists (editable during development)
  let sandboxSkill: string | undefined;
  try {
    sandboxSkill = await Bun.file(join(sandboxPath, 'SKILL.md')).text();
  } catch {
    // No sandbox SKILL.md
  }

  // Read sandbox's app.json as the base (preserves permissions, etc. from clone)
  let sandboxMeta: Record<string, unknown> = {};
  try {
    sandboxMeta = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
  } catch {
    // No sandbox app.json
  }

  // Also read existing deployed app's metadata for fallback values
  let existingMeta: Record<string, unknown> = {};
  try {
    existingMeta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
  } catch {
    // New app
  }

  const resolvedIcon = icon ?? (existingMeta.icon as string | undefined) ?? '🎮';
  const displayName = name ?? (existingMeta.name as string | undefined) ?? toDisplayName(appId);

  try {
    try {
      await stat(appPath);
      await rm(join(appPath, 'src'), { recursive: true, force: true });
      await rm(join(appPath, 'dist'), { recursive: true, force: true });
    } catch {
      // App doesn't exist yet
    }

    await mkdir(appPath, { recursive: true });

    if (hasCompiledApp) {
      const appDistDir = join(appPath, 'dist');
      await mkdir(appDistDir, { recursive: true });
      await cp(distIndexPath, join(appDistDir, 'index.html'));
      // Copy build manifest if it exists (enables auto-compile change detection)
      try {
        await cp(
          join(sandboxPath, 'dist', '.build-manifest.json'),
          join(appDistDir, '.build-manifest.json'),
        );
      } catch {
        // No manifest — will be regenerated on next server start
      }
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

    if (sandboxSkill) {
      // Use SKILL.md from sandbox directly
      await Bun.write(join(appPath, 'SKILL.md'), sandboxSkill);
    } else {
      const skillContent = generateSkillMd(
        appId,
        displayName,
        hasCompiledApp,
        componentFiles,
        skill,
        !!extractedProtocol,
      );
      await Bun.write(join(appPath, 'SKILL.md'), skillContent);
    }

    // Copy HINT.md from sandbox if it exists (monitor agent orchestration hints)
    try {
      const hintContent = await Bun.file(join(sandboxPath, 'HINT.md')).text();
      await Bun.write(join(appPath, 'HINT.md'), hintContent);
    } catch {
      // No HINT.md in sandbox
    }

    // Sandbox app.json is the source of truth for all metadata (permissions, variant, etc.)
    // Deploy args only override name/icon/description for convenience.
    const metadata: Record<string, unknown> = { ...existingMeta, ...sandboxMeta };
    if (name !== undefined) metadata.name = name;
    else if (!metadata.name) metadata.name = displayName;
    if (icon !== undefined) metadata.icon = icon;
    else if (!metadata.icon) metadata.icon = resolvedIcon;
    if (description !== undefined) metadata.description = description;
    if (hasCompiledApp) metadata.run = 'dist/index.html';
    if (!metadata.version) metadata.version = '1.0.0';
    if (!metadata.author) metadata.author = 'YAAR';
    // Remove legacy fields
    delete metadata.hidden;
    delete metadata.appProtocol;
    delete metadata.protocol;
    await Bun.write(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2) + '\n');

    // Write protocol.json to dist/ (compiler already writes it, but cover source-only extraction)
    if (extractedProtocol) {
      const protocolDistDir = join(appPath, 'dist');
      await mkdir(protocolDistDir, { recursive: true });
      await Bun.write(
        join(protocolDistDir, 'protocol.json'),
        JSON.stringify(extractedProtocol, null, 2) + '\n',
      );
    }

    const finalName = (metadata.name as string) ?? displayName;
    const finalIcon = (metadata.icon as string) ?? resolvedIcon;

    if (metadata.createShortcut !== false) {
      await ensureAppShortcut({
        id: appId,
        name: finalName,
        icon: finalIcon,
        iconType: 'emoji',
      });
      actionEmitter.emitAction({
        type: 'desktop.createShortcut',
        shortcut: {
          id: `app-${appId}`,
          label: finalName,
          icon: finalIcon,
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

    // Emit refreshApps AFTER shortcut changes are persisted to disk.
    actionEmitter.emitAction({ type: 'desktop.refreshApps' });

    return { success: true, appId, name: finalName, icon: finalIcon };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Failed to deploy app: ${msg}` };
  }
}
