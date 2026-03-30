/**
 * App development deploy logic.
 */

import { mkdir, cp, readdir, stat, rm, unlink } from 'fs/promises';
import { join } from 'path';
import { compileTypeScript, getSandboxPath, extractProtocolFromSource } from '@yaar/compiler';
import { PROJECT_ROOT } from '../../config.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { type AppManifest, buildYaarUri } from '@yaar/shared';
import { toDisplayName, generateSkillMd } from './helpers.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

/**
 * Sync a source directory to a destination, only writing files whose content changed.
 * Preserves permissions of unchanged files. Removes files not in source.
 */
async function syncDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });

  // Collect source files
  const srcFiles = new Set<string>();
  const entries = await readdir(src, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const relPath = entry.parentPath
      ? join(entry.parentPath, entry.name).slice(src.length + 1)
      : entry.name;
    if (entry.isDirectory()) {
      await mkdir(join(dest, relPath), { recursive: true });
      continue;
    }
    srcFiles.add(relPath);
    const srcBuf = await Bun.file(join(src, relPath)).arrayBuffer();
    try {
      const destBuf = await Bun.file(join(dest, relPath)).arrayBuffer();
      if (
        srcBuf.byteLength === destBuf.byteLength &&
        Buffer.from(srcBuf).equals(Buffer.from(destBuf))
      ) {
        continue; // Content identical — skip to preserve permissions
      }
    } catch {
      // Destination file doesn't exist yet
    }
    await Bun.write(join(dest, relPath), srcBuf);
  }

  // Remove files in dest that aren't in source anymore
  // (also cleans up renamed/deleted source files)
  try {
    const destEntries = await readdir(dest, { recursive: true, withFileTypes: true });
    for (const entry of destEntries) {
      if (entry.isDirectory()) continue;
      const relPath = entry.parentPath
        ? join(entry.parentPath, entry.name).slice(dest.length + 1)
        : entry.name;
      if (!srcFiles.has(relPath)) {
        await unlink(join(dest, relPath));
      }
    }
  } catch {
    // dest doesn't exist yet — nothing to clean
  }
}

/** Write a file only if its content actually changed, preserving permissions. */
async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await Bun.file(filePath).text();
    if (existing === content) return;
  } catch {
    // File doesn't exist yet
  }
  await Bun.write(filePath, content);
}

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
    await mkdir(appPath, { recursive: true });

    if (hasCompiledApp) {
      // dist/ is generated output — safe to replace entirely
      await rm(join(appPath, 'dist'), { recursive: true, force: true });
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
        // Sync instead of delete+copy to preserve file permissions for unchanged files
        await syncDir(srcPath, join(appPath, 'src'));
      } catch {
        // No src directory
      }
    }

    for (const f of componentFiles) {
      await cp(join(sandboxPath, f), join(appPath, f));
    }

    const skillContent = sandboxSkill
      ? sandboxSkill
      : generateSkillMd(
          appId,
          displayName,
          hasCompiledApp,
          componentFiles,
          skill,
          !!extractedProtocol,
        );
    await writeIfChanged(join(appPath, 'SKILL.md'), skillContent);

    // Copy HINT.md from sandbox if it exists (monitor agent orchestration hints)
    try {
      const hintContent = await Bun.file(join(sandboxPath, 'HINT.md')).text();
      await writeIfChanged(join(appPath, 'HINT.md'), hintContent);
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
    await writeIfChanged(join(appPath, 'app.json'), JSON.stringify(metadata, null, 2) + '\n');

    // Write protocol.json to dist/ (compiler already writes it, but cover source-only extraction)
    if (extractedProtocol) {
      const protocolDistDir = join(appPath, 'dist');
      await mkdir(protocolDistDir, { recursive: true });
      await writeIfChanged(
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
