import { wait, defineAppCommand, AppCommandError } from '@bundled/yaar';
import {
  diagnostics,
  bundleStatus,
  compileErrors,
  compileWarnings,
  previewWindowId,
  staticProtocol,
} from '../core';
import { resolveCompileStatus } from '../lib';
import {
  compile,
  typecheck,
  deploy,
  openPreview,
  previewFaultsNote,
  previewStaleNote,
  getStaticManifest,
  getRuntimeManifest,
  diffManifestNames,
  formatFiles,
  checkProject,
  summarizeCheck,
  regressionWarning,
  previewMountErrors,
} from '../services';

export const buildCommands = {
  'build/compile': defineAppCommand({
    description:
      'Typecheck + bundle the active project; remounts the open preview, resetting its state ' +
      '(`refreshPreview: false` keeps it on the old build). Result fields match `compileState`: ' +
      '`built` is the bundle, `status` the combined verdict. Bun strips types and builds ' +
      'through them, so `bundler` holds only what stopped the bundle (unresolved imports, ' +
      'syntax, a failed plugin) and `typecheck` is the only place type errors appear. ' +
      '`warnings` did not fail the build (an unknown y-* class, add*/delete* commands with no ' +
      '`replay`); `previewErrors` ({ count, first }) is what the preview logged while ' +
      'mounting. Slow: pass timeoutMs (e.g. 60000).',
    params: {
      type: 'object',
      properties: {
        skipTypecheck: {
          type: 'boolean',
          description:
            'Build without type checking first. Faster, but ships blind — and typecheck is ' +
            'the only half that reads import paths, because Bun tree-shakes an unused bad ' +
            'import away and reports a clean build. Leaves `compileState.status` at "unchecked".',
        },
        refreshPreview: {
          type: 'boolean',
          description:
            'Whether to remount the open preview onto this build. Default true. Pass false ' +
            'when the preview holds expensive state (a loaded fixture, a scrape, a ' +
            'multi-step form) that a cold start would cost you more than the stale build ' +
            'costs — the window then keeps running the previous build, and every preview ' +
            'read says so until you run `preview/open`. Skips the manifest-drift check, which ' +
            'needs a preview on the current build.',
        },
      },
    },
    run: async (p) => {
      // Compiling does not typecheck, so one call does both: check first, build regardless,
      // report both.
      const skip = p.skipTypecheck === true;
      if (!skip) await typecheck();
      await compile();
      const built = bundleStatus() === 'success';
      const errors = compileErrors();
      const diags = skip ? [] : diagnostics();
      const typeErrors = diags.filter((d) => d.severity === 'error').length;

      // Bun strips types and builds through them, so "it built" and "it type checks" are
      // separate facts: `built` for the bundle, `status` for the code. Deploy enforces the
      // same line.
      //
      // `skipTypecheck` gets its own status rather than `success`, matching the
      // `compileState` state key.
      const status = resolveCompileStatus(
        built ? 'success' : 'error',
        skip ? 'unknown' : typeErrors === 0 ? 'clean' : 'errors',
      );

      // Refresh an open preview onto the build we just made; otherwise a screenshot taken
      // to confirm a fix shows the code from before it. Re-opening remounts the iframe,
      // which resets app state.
      //
      // With `refreshPreview: false` the remount is skipped and the window is *marked*
      // stale (previewIsStale), and every preview read leads with that. Keep the marker
      // if you touch this: an unmarked stale preview is the failure.
      const wantRefresh = p.refreshPreview !== false;
      let previewRefreshed = false;
      if (built && previewWindowId() && wantRefresh) {
        await openPreview();
        previewRefreshed = true;
      }
      const previewStale = previewStaleNote();

      // Best-effort manifest drift check: with a freshly refreshed preview,
      // compare what the compiler extracted (what agents will see after
      // deploy) against what the running app actually registered. A command
      // reached via a spread or computed key runs fine but vanishes from
      // the static manifest — this is where that mismatch surfaces instead
      // of staying latent until deploy. Any fetch failure drops the check
      // silently; it is advisory, never a reason to fail a compile.
      let manifestDrift: ReturnType<typeof diffManifestNames> | undefined;
      let previewErrors: Awaited<ReturnType<typeof previewMountErrors>>;
      if (previewRefreshed) {
        await wait(800); // the remounted iframe needs a beat to boot and register
        const statNames = staticProtocol()?.protocol;
        if (statNames) {
          const runtime = await getRuntimeManifest();
          if (runtime.names) {
            const drift = diffManifestNames(statNames, runtime.names);
            if (drift.missingFromStatic.length > 0 || drift.missingFromRuntime.length > 0) {
              manifestDrift = drift;
            }
          }
        }
        // A build that throws on mount still reports `built`.
        previewErrors = await previewMountErrors();
      }

      return {
        status,
        built,
        ...(previewRefreshed ? { previewRefreshed } : {}),
        ...(previewStale ? { previewStale } : {}),
        ...(previewRefreshed && previewFaultsNote() ? { previewFaults: previewFaultsNote() } : {}),
        ...(previewErrors ? { previewErrors } : {}),
        ...(typeErrors > 0 ? { typeErrors } : {}),
        ...(!built && errors.length > 0 ? { bundler: errors } : {}),
        ...(built && compileWarnings().length > 0 ? { warnings: [...compileWarnings()] } : {}),
        ...(diags.length > 0 ? { typecheck: diags } : {}),
        ...(manifestDrift
          ? {
              manifestDrift,
              manifestNote:
                'warning: the runtime registration and the static protocol manifest ' +
                'disagree — entries reached via spreads or computed keys are invisible to ' +
                'agents. Run build/manifest for details.',
            }
          : {}),
      };
    },
  }),
  'build/typecheck': defineAppCommand({
    description:
      'Type check the active project without bundling; the preview is left alone. The check ' +
      'to run after an edit. Records into `compileState.typecheck`. Returns { clean, errors, ' +
      'warnings, diagnostics: [{ file, line, column, code, message, severity }] }.',
    params: { type: 'object', properties: {} },
    replay: 'never',
    run: async () => {
      const failed = await typecheck();
      if (failed) throw new AppCommandError(`Typecheck did not run: ${failed}`);
      const diags = [...diagnostics()];
      const errors = diags.filter((d) => d.severity === 'error').length;
      return {
        clean: errors === 0,
        errors,
        warnings: diags.length - errors,
        diagnostics: diags,
      };
    },
  }),
  'build/format': defineAppCommand({
    description:
      "Run the host's Prettier (the repo's style) over .ts/.tsx/.js/.jsx/.css; dist/ and " +
      '.json are left alone. Each rewritten file comes back as { path, lines, added, removed }, ' +
      '`lines` being where it changed in the new file ("12, 40-44"). A file Prettier cannot ' +
      'parse is `skipped` with its syntax error — after an edit, that usually means the edit ' +
      'broke parsing.',
    params: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Project-relative files to format. Omit to format every formattable file in ' +
            'the project.',
        },
        onlyChanged: {
          type: 'boolean',
          description:
            'Apply formatting only where it overlaps lines changed since the oldest recorded ' +
            'edit of each file (the Changes history keeps the last 40 edits); a formatter ' +
            'change that runs into an edited line is taken whole. A file with no recorded ' +
            'edit is left alone and counted in `untouched`.',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      const paths = Array.isArray(p.paths) ? p.paths.map(String) : undefined;
      const outcome = await formatFiles(paths, { onlyChanged: p.onlyChanged === true });
      return {
        status: outcome.skipped.length > 0 ? 'partial' : 'success',
        ...outcome,
      };
    },
  }),
  'build/manifest': defineAppCommand({
    description:
      'List commands and state keys declared in source but not registered by the running ' +
      'preview, and vice versa (drift: usually a registration that threw, or a stale ' +
      'preview). build/compile runs the same check; this is the full report. Needs a compile ' +
      'and an open preview.',
    params: { type: 'object', properties: {} },
    run: async () => {
      const stat = await getStaticManifest();
      const runtime = await getRuntimeManifest();
      const result = {
        static: stat.names
          ? {
              available: true as const,
              source: stat.source,
              commands: stat.names.commands,
              state: stat.names.state,
            }
          : {
              available: false as const,
              reason: stat.reason ?? 'Static manifest unavailable.',
            },
        runtime: runtime.names
          ? {
              available: true as const,
              commands: runtime.names.commands,
              state: runtime.names.state,
            }
          : {
              available: false as const,
              reason: runtime.reason ?? 'Runtime manifest unavailable.',
            },
      };
      if (stat.names && runtime.names) {
        return { ...result, drift: diffManifestNames(stat.names, runtime.names) };
      }
      const note =
        !stat.names && !runtime.names
          ? 'Neither side is available — run build/compile (static) and preview/open ' +
            '(runtime), then retry.'
          : !stat.names
            ? 'Only the runtime side is available, so no drift check was possible. ' +
              (stat.reason ?? '')
            : 'Only the static side is available, so no drift check was possible. ' +
              (runtime.reason ?? '');
      return { ...result, note: note.trim() };
    },
  }),
  'build/deploy': defineAppCommand({
    description:
      'Deploy to apps/. Refuses type errors unless skipTypecheck, and a manifest that drops ' +
      'installed commands unless allowProtocolShrink. Snapshots the previous version ' +
      "(git/restore). Closes the preview and the user's open windows of the app, listed in " +
      '`closedWindows` with their in-app state lost — say so before deploying an app the user ' +
      'has open. Result: `version` as deployed, `installedVersion`, `bumped` when the version ' +
      'moved (rule: the version-history topic), `agentModel`, and `staleWindow` when you ' +
      'deployed the app you run inside — that window still runs the old bundle until ' +
      "invoke('yaar://windows/{staleWindow}', {action:'reload'}).",
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        name: { type: 'string' },
        icon: { type: 'string' },
        description: { type: 'string' },
        message: { type: 'string', description: 'Commit message for this deploy.' },
        skipTypecheck: { type: 'boolean', description: 'Ship despite type errors.' },
        allowProtocolShrink: {
          type: 'boolean',
          description: 'Ship despite dropping commands the installed app currently exposes.',
        },
        bump: {
          type: 'boolean',
          description:
            'Omit for the automatic rule. true: always raise one patch step, even over ' +
            'a hand-set higher version. false: deploy app.json `version` as written, for a ' +
            'pure redeploy of an unchanged build. Any bump is reverted if the deploy fails.',
        },
      },
      required: ['appId'],
    },
    replay: 'never',
    run: async (p) => {
      // Read before the deploy: the version bump it writes would count as an edit after
      // the last regression run.
      const testWarning = await regressionWarning().catch(() => null);
      const result = await deploy({
        appId: String(p.appId),
        name: p.name ? String(p.name) : undefined,
        icon: p.icon ? String(p.icon) : undefined,
        description: p.description ? String(p.description) : undefined,
        message: p.message ? String(p.message) : undefined,
        skipTypecheck: p.skipTypecheck === true,
        allowProtocolShrink: p.allowProtocolShrink === true,
        bump: typeof p.bump === 'boolean' ? p.bump : undefined,
      });
      const checks = await checkProject()
        .then(summarizeCheck)
        .catch(() => []);
      return {
        ...result,
        ...(testWarning ? { testWarning } : {}),
        ...(checks.length ? { checkNotes: [...checks, 'Details: build/check.'] } : {}),
      };
    },
  }),
  'build/check': defineAppCommand({
    description:
      'Static checks the type checker and bundler do not make. `staleFileRefs`: source files ' +
      'named in comments or Markdown that do not exist. `css.unused`: project CSS classes no ' +
      'source string names. `css.unstyled`: classes on elements with no project rule. ' +
      '`css.unknownSdk`: y-* classes the tokens do not define (they fail silently). ' +
      '`permissions.missing`: yaar:// uses ({ verb, uri, file, line, via }) app.json does not ' +
      "grant — each a runtime 403, judged by the server's own check (`httpFetch` and " +
      'cross-origin `fetch` count as yaar://http; runtime-built URIs are not read). ' +
      '`permissions.problems`: app.json entries not honoured as written. `storagePolling`: a ' +
      'timer whose callback reads storage — subscribe instead (the multi-window-sync topic). ' +
      'Lexical and heuristic: read each finding before acting on it.',
    params: { type: 'object', properties: {} },
    replay: 'never',
    run: async () => await checkProject(),
  }),
};
