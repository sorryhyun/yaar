/**
 * App development deploy logic.
 */

import { mkdir, cp, readdir, stat, rm, unlink } from 'fs/promises';
import { join } from 'path';
import {
  compileTypeScript,
  typecheckSandbox,
  getSandboxPath,
  extractProtocolFromDir,
  formatProtocolError,
} from '@yaar/compiler';
import { actionEmitter } from '../../session/action-emitter.js';
import { publishFrame } from '../../streams/stream-hub.js';
import { type AppManifest, buildYaarUri } from '@yaar/shared';
import { toDisplayName, generateSkillMd } from './helpers.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { APPS_DIR, resolveAppDir } from '../apps/roots.js';
import { snapshotApp } from './git.js';

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

/** The `bundles` an app opted into — gates `@bundled/yaar-*` in both compile and typecheck. */
async function readBundles(sandboxPath: string): Promise<string[] | undefined> {
  try {
    const appMeta = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
    if (Array.isArray(appMeta.bundles)) return appMeta.bundles;
  } catch {
    /* no app.json, or unreadable */
  }
  return undefined;
}

export interface DeployArgs {
  appId: string;
  name?: string;
  description?: string;
  icon?: string;
  keepSource?: boolean;
  skill?: string;
  sourcePath?: string; // Override sandbox path — use this directory as source
  message?: string; // Commit message for this deploy's history snapshot
  /** Ship without type checking. Escape hatch — the caller is stating they know. */
  skipTypecheck?: boolean;
  /**
   * Ship a manifest that drops commands the installed app currently has. Deploy
   * compares the new protocol against the installed dist/protocol.json and
   * refuses shrink — this states you know, and want it anyway.
   */
  allowProtocolShrink?: boolean;
  /**
   * Session to scope deploy-progress stream frames to. When set, `doDeploy`
   * pushes `progress`/`done`/`error` frames to `yaar://dev/deploy/{appId}` for
   * any app streaming that URI (e.g. devtools' live deploy bar). Omit for
   * callers with no session (tests, CLI).
   */
  sessionId?: string;
}

export interface DeployResult {
  success: true;
  appId: string;
  name: string;
  icon: string;
}

export interface DeployRefusal {
  success: false;
  error: string;
  /** Present when the protocol shrink gate refused. Counts are commands. */
  protocolShrink?: { before: number; after: number; missing: string[] };
}

export async function doDeploy(
  sandboxId: string,
  args: DeployArgs,
): Promise<DeployResult | DeployRefusal> {
  const { appId, name, description, icon, keepSource = true, skill, skipTypecheck } = args;

  // Deploy-progress stream. Frames go to any app streaming this URI; a no-op
  // when no one is subscribed (or no sessionId was passed).
  const deployUri = `yaar://dev/deploy/${appId}`;
  const emit = (kind: 'progress' | 'done' | 'error', data: Record<string, unknown>): void => {
    if (args.sessionId) publishFrame(deployUri, kind, { appId, ...data }, args.sessionId);
  };

  if (!/^[a-z][a-z0-9-]*$/.test(appId)) {
    return {
      success: false,
      error:
        'Invalid app ID. Use lowercase letters, numbers, and hyphens. Must start with a letter.',
    };
  }

  emit('progress', { step: 'start', message: `Deploying ${appId}…` });

  const sandboxPath = args.sourcePath ?? getSandboxPath(sandboxId);
  // Update an existing app in place; newly deployed apps go to the bundled
  // `apps/` tree.
  const appPath = resolveAppDir(appId) ?? join(APPS_DIR, appId);

  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }

  // Type-check the source before any of it reaches apps/.
  //
  // Bundling does not type check — Bun strips types and builds happily around them — so
  // "compile succeeded" never meant "this type checks", and nothing between a broken type
  // and a live app ever said otherwise. The check lived one call earlier, in devtools' own
  // typecheck button, which a deploy could simply not press. Put it in the deploy itself:
  // it is the last door, and the only one every caller (devtools, yaar-dev, an agent
  // driving the verb directly) has to walk through.
  //
  // A sandbox with no source (components-only deploy) has nothing to check. Bundled-exe
  // mode has no tsc, and typecheckSandbox reports success there rather than blocking a
  // deploy it cannot judge.
  const hasSource = await stat(join(sandboxPath, 'src'))
    .then(() => true)
    .catch(() => false);
  if (hasSource && !skipTypecheck) {
    emit('progress', { step: 'typecheck', message: 'Type checking…' });
    const result = await typecheckSandbox(sandboxPath, { bundles: await readBundles(sandboxPath) });
    if (!result.success) {
      const diagnostics = result.diagnostics ?? [];
      const error =
        `Type check failed — refusing to deploy "${appId}". ` +
        `Fix these, or pass skipTypecheck to ship anyway:\n${diagnostics.join('\n')}`;
      emit('error', { step: 'typecheck', error, diagnostics });
      return { success: false, error };
    }
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
      emit('progress', { step: 'compile', message: 'Compiling…' });
      const compileResult = await compileTypeScript(sandboxPath, {
        title: name ?? toDisplayName(appId),
        bundles: await readBundles(sandboxPath),
      });
      if (!compileResult.success) {
        const error = `Auto-compile failed:\n${compileResult.errors?.join('\n') ?? 'Unknown error'}`;
        emit('error', { step: 'compile', error });
        return { success: false, error };
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
    // No dist/protocol.json — extract directly from source. This must use the
    // same extractor the compiler does: a weaker read here under-reports the
    // command set, and the shrink gate below would then refuse a deploy that
    // drops nothing.
    //
    // Extraction failures have to be raised here rather than left to the shrink
    // gate. That gate only fires when there is an installed manifest to compare
    // against, so on a *first* deploy an unresolvable protocol would sail
    // through and install an app whose commands no agent can see.
    try {
      const extraction = await extractProtocolFromDir(join(sandboxPath, 'src'));
      if (extraction.errors.length > 0) {
        const error =
          `Protocol extraction failed - the manifest would silently drop entries:\n` +
          extraction.errors.map(formatProtocolError).join('\n');
        emit('error', { step: 'protocol', error });
        return { success: false, error };
      }
      if (extraction.protocol) extractedProtocol = extraction.protocol;
    } catch (err) {
      const error = `Protocol extraction failed: ${err instanceof Error ? err.message : String(err)}`;
      emit('error', { step: 'protocol', error });
      return { success: false, error };
    }
  }

  // Protocol shrink gate. The extractor is best-effort, so a manifest that
  // parsed short (or not at all) would silently overwrite the installed app's
  // protocol.json — and the agent loses commands it could see yesterday, with
  // every other signal green. Compare against what is installed and refuse to
  // shrink the command set unless the caller says so on purpose. First deploys
  // have nothing to compare; components-only deploys leave dist/ untouched.
  if (hasCompiledApp || extractedProtocol) {
    let installed: Pick<AppManifest, 'state' | 'commands'> | null = null;
    try {
      installed = JSON.parse(await Bun.file(join(appPath, 'dist', 'protocol.json')).text());
    } catch {
      // No installed manifest (first deploy, or app never had one) — exempt.
    }
    if (installed && !args.allowProtocolShrink) {
      const beforeCommands = Object.keys(installed.commands ?? {});
      const afterCommands = Object.keys(extractedProtocol?.commands ?? {});
      const missing = beforeCommands.filter((k) => !afterCommands.includes(k));
      if (missing.length > 0) {
        const beforeState = Object.keys(installed.state ?? {});
        const afterState = Object.keys(extractedProtocol?.state ?? {});
        const missingState = beforeState.filter((k) => !afterState.includes(k));
        const error =
          `Protocol shrinks from ${beforeCommands.length} to ${afterCommands.length} commands; ` +
          `missing: ${missing.join(', ')}.` +
          (missingState.length > 0 ? ` Also missing state keys: ${missingState.join(', ')}.` : '') +
          ` Pass allowProtocolShrink: true if intended.`;
        const protocolShrink = {
          before: beforeCommands.length,
          after: afterCommands.length,
          missing,
        };
        emit('error', { step: 'protocol', error, protocolShrink });
        return { success: false, error, protocolShrink };
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

  // Deploy is destructive: `syncDir` deletes files no longer in source and dist/
  // is wiped. Snapshot the current state first so the previous version is always
  // recoverable via `restoreApp()`. No-ops for an app being created for the
  // first time (nothing on disk to snapshot yet).
  await snapshotApp(appId, `checkpoint: before deploy of ${appId}`);

  emit('progress', { step: 'write', message: 'Writing files…' });

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

    // Copy AGENTS.md from sandbox if it exists (full custom app-agent prompt).
    // `cloneApp` pulls it into the sandbox, so a deploy that skipped it would
    // silently discard every edit the user made to the app agent's prompt.
    try {
      const agentsContent = await Bun.file(join(sandboxPath, 'AGENTS.md')).text();
      await writeIfChanged(join(appPath, 'AGENTS.md'), agentsContent);
    } catch {
      // No AGENTS.md in sandbox
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

    // Record the deployed state as a commit — this is the ref a later deploy
    // rolls back to.
    await snapshotApp(appId, args.message?.trim() || `deploy: ${appId}`);

    emit('done', { name: finalName, icon: finalIcon });

    return { success: true, appId, name: finalName, icon: finalIcon };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const error = `Failed to deploy app: ${msg}`;
    emit('error', { step: 'write', error });
    return { success: false, error };
  }
}
