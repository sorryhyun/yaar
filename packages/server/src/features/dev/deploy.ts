/**
 * App development deploy logic.
 */

import { mkdir, cp, readdir, stat, rm, unlink } from 'fs/promises';
import { dirname, join } from 'path';
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
import { toDisplayName } from './helpers.js';
import { ensureAppShortcut, removeAppShortcut } from '../../storage/shortcuts.js';
import { APPS_DIR, appIdRefusal, resolveAppDir } from '../apps/roots.js';
import { agentDocPaths, APP_ROOT_DOCS, invalidateAppsCache } from '../apps/discovery.js';
import { retireStaleApp } from '../apps/retire.js';
import { snapshotApp } from './git.js';

/**
 * Sync a source directory to a destination, only writing files whose content changed.
 * Preserves permissions of unchanged files. Removes files not in source.
 */
async function syncDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });

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
      // Dest file doesn't exist yet — fall through to write it.
    }
    await Bun.write(join(dest, relPath), srcBuf);
  }

  // Also cleans up renamed/deleted source files
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
    // dest doesn't exist yet — nothing to clean up.
  }
}

/** Write a file only if its content actually changed, preserving permissions. */
async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await Bun.file(filePath).text();
    if (existing === content) return;
  } catch {
    // File doesn't exist yet — fall through to write it.
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
  /**
   * Windows of this app that were closed because they were still running the previous
   * build. Empty when none were open (or when the only one was the deployer's own).
   */
  closedWindows: string[];
  /**
   * Set when the deployer was itself inside a window of the app it just deployed — a
   * self-deploy. That window is spared (see `features/apps/retire.ts`) and is therefore
   * still running the *previous* bundle, which is the trap this field exists to close:
   * the deploy succeeded, the files on disk are right, and the code actually executing is
   * the code that was just replaced. Anything verified against that window is a false
   * result. Reload it — `invoke('yaar://windows/{id}', { action: 'reload' })` — once the
   * deploy's own answer has been delivered.
   */
  staleWindow?: string;
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
  const { appId, name, description, icon, keepSource = true, skipTypecheck } = args;

  // Deploy-progress stream. Frames go to any app streaming this URI; a no-op
  // when no one is subscribed (or no sessionId was passed).
  const deployUri = `yaar://dev/deploy/${appId}`;
  const emit = (kind: 'progress' | 'done' | 'error', data: Record<string, unknown>): void => {
    if (args.sessionId) publishFrame(deployUri, kind, { appId, ...data }, args.sessionId);
  };

  const refusal = appIdRefusal(appId);
  if (refusal) return { success: false, error: refusal };

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
      // No src/main.ts to auto-compile either — hasCompiledApp stays false.
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
      // `bundles` matters because extraction may have to *run* the app to fold a
      // Zod schema, and that build resolves gated SDKs through the same gate the
      // compile did. Omitting it would fail an app on a permission it has.
      const extraction = await extractProtocolFromDir(join(sandboxPath, 'src'), {
        bundles: await readBundles(sandboxPath),
      });
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
    // sandboxPath doesn't exist — componentFiles stays empty.
  }

  if (!hasCompiledApp && componentFiles.length === 0) {
    return { success: false, error: 'Nothing to deploy. Run compile first.' };
  }

  // Base metadata preserves permissions, etc. carried over from clone.
  let sandboxMeta: Record<string, unknown> = {};
  try {
    sandboxMeta = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
  } catch {
    // No app.json in the sandbox — sandboxMeta stays empty.
  }

  // `appId` in app.json is what protocol extraction compares `defineApp({ id })`
  // against, so deploying under a *different* id installs an app whose own next
  // compile fails on a mismatch it did nothing to cause. Refuse here, where both
  // names are in hand and the fix is one edit, rather than at that later build.
  const declaredAppId = sandboxMeta.appId;
  if (typeof declaredAppId === 'string' && declaredAppId && declaredAppId !== appId) {
    const error =
      `This project's app.json declares appId "${declaredAppId}" but you are deploying as ` +
      `"${appId}". The id is what the app registers under and what \`defineApp({ id })\` must ` +
      `equal, so deploy with appId "${declaredAppId}", or change both app.json's "appId" and ` +
      `the \`id\` in src/main.ts to "${appId}".`;
    emit('error', { step: 'metadata', error });
    return { success: false, error };
  }

  let existingMeta: Record<string, unknown> = {};
  try {
    existingMeta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
  } catch {
    // No existing app.json — this is a first deploy.
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
        // Regenerated on next server start
      }
    }

    if (keepSource) {
      const srcPath = join(sandboxPath, 'src');
      try {
        await stat(srcPath);
        // Sync instead of delete+copy to preserve file permissions for unchanged files
        await syncDir(srcPath, join(appPath, 'src'));
      } catch {
        // No src/ in the sandbox — nothing to copy.
      }
    }

    for (const f of componentFiles) {
      await cp(join(sandboxPath, f), join(appPath, f));
    }

    // Carry the docs across — `agent/prompt.md` is the app agent's whole system prompt,
    // `agent/hint.md` is what the monitor agent is told about the app, and `AGENTS.md`
    // is what the *coding* agent reads before editing it. `cloneApp` pulls all of them
    // into the sandbox, so a deploy that skipped one would silently discard every edit
    // the user made to it — which is what happened to `AGENTS.md`: devtools would write
    // an app's architecture notes, deploy, and the file existed nowhere but the sandbox.
    // The agent-doc paths come from the sandbox's own app.json, so a doc lands where the
    // reader will look for it; the root docs are at fixed names by definition.
    for (const relPath of [...Object.values(agentDocPaths(sandboxMeta)), ...APP_ROOT_DOCS]) {
      let content: string;
      try {
        content = await Bun.file(join(sandboxPath, relPath)).text();
      } catch {
        continue; // not in the sandbox — the common case
      }
      await mkdir(dirname(join(appPath, relPath)), { recursive: true });
      await writeIfChanged(join(appPath, relPath), content);
    }

    // Sandbox app.json is the source of truth for all metadata (permissions, variant, etc.)
    // Deploy args only override name/icon/description for convenience.
    const metadata: Record<string, unknown> = { ...existingMeta, ...sandboxMeta };
    // Stamped, not inherited: the guard above has already established that the
    // sandbox either agrees or said nothing, and an installed app.json that names
    // its own id is what keeps the `defineApp({ id })` check live for every later
    // build of it — including the server's own auto-recompile.
    metadata.appId = appId;
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

    // App files on disk just changed — drop the cached listing so the
    // frontend's refreshApps fetch and any agent describe sees the new build.
    invalidateAppsCache();

    // Everything already running this app is now running the *previous* build: an open
    // window's iframe holds the old bundle, and the app agent's cached profile holds the
    // old manifest. Close the windows and drop the profile so the next launch and the
    // next turn both come from what was just written. The one window a deploy cannot
    // close is the one it is being issued from, so that one is reported instead — see
    // features/apps/retire.ts.
    const { closed: closedWindows, staleWindow } = retireStaleApp(appId);

    // Emit refreshApps AFTER shortcut changes are persisted to disk.
    actionEmitter.emitAction({ type: 'desktop.refreshApps' });

    // Record the deployed state as a commit — this is the ref a later deploy
    // rolls back to.
    await snapshotApp(appId, args.message?.trim() || `deploy: ${appId}`);

    emit('done', { name: finalName, icon: finalIcon, closedWindows, staleWindow });

    return {
      success: true,
      appId,
      name: finalName,
      icon: finalIcon,
      closedWindows,
      ...(staleWindow ? { staleWindow } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const error = `Failed to deploy app: ${msg}`;
    emit('error', { step: 'write', error });
    return { success: false, error };
  }
}
