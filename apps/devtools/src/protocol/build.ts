import { wait, defineAppCommand } from '@bundled/yaar';
import {
  diagnostics,
  bundleStatus,
  compileErrors,
  previewUrl,
  previewWindowId,
  staticProtocol,
} from '../core';
import { resolveCompileStatus } from '../lib';
import {
  compile,
  typecheck,
  deploy,
  openPreview,
  previewStaleNote,
  getStaticManifest,
  getRuntimeManifest,
  diffManifestNames,
  formatFiles,
} from '../services';

export const buildCommands = {
  compile: defineAppCommand({
    description:
      'Type check and compile the active project; refreshes the preview window if one is ' +
      'open. `built` reflects the bundle, `status` reflects type checking too — they can ' +
      'differ, and the `compileStatus` state key reports the same combined verdict. ' +
      'Refreshing the preview remounts the iframe, so in-app state resets to a cold start; ' +
      'pass `refreshPreview: false` to keep that state and leave the window on the old ' +
      'build. Slow: pass timeoutMs (e.g. 60000).',
    params: {
      type: 'object',
      properties: {
        skipTypecheck: {
          type: 'boolean',
          description:
            'Build without type checking first. Faster, but ships blind — and typecheck is ' +
            'the only half that reads import paths, because Bun tree-shakes an unused bad ' +
            'import away and reports a clean build. Leaves `compileStatus` at "unchecked".',
        },
        refreshPreview: {
          type: 'boolean',
          description:
            'Whether to remount the open preview onto this build. Default true. Pass false ' +
            'when the preview holds expensive state (a loaded fixture, a scrape, a ' +
            'multi-step form) that a cold start would cost you more than the stale build ' +
            'costs — the window then keeps running the previous build, and every preview ' +
            'read says so until you run `preview`. Skips the manifest-drift check, which ' +
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
      // `compileStatus` state key.
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
      if (previewRefreshed) {
        const statNames = staticProtocol()?.protocol;
        if (statNames) {
          await wait(800); // the remounted iframe needs a beat to boot and register
          const runtime = await getRuntimeManifest();
          if (runtime.names) {
            const drift = diffManifestNames(statNames, runtime.names);
            if (drift.missingFromStatic.length > 0 || drift.missingFromRuntime.length > 0) {
              manifestDrift = drift;
            }
          }
        }
      }

      return {
        status,
        built,
        previewUrl: previewUrl(),
        ...(previewRefreshed ? { previewRefreshed } : {}),
        ...(previewStale ? { previewStale } : {}),
        ...(typeErrors > 0 ? { typeErrors } : {}),
        ...(!built && errors.length > 0 ? { errors } : {}),
        ...(diags.length > 0 ? { diagnostics: diags } : {}),
        ...(manifestDrift
          ? {
              manifestDrift,
              manifestNote:
                'warning: the runtime registration and the static protocol manifest ' +
                'disagree — entries reached via spreads or computed keys are invisible to ' +
                'agents. Run the manifest command for details.',
            }
          : {}),
      };
    },
  }),
  format: defineAppCommand({
    description:
      "Run the host's Prettier over the project, in the repo's own style — the style " +
      'deployed apps are read and reviewed in. Formats .ts/.tsx/.js/.jsx/.css and leaves ' +
      'dist/ and .json alone. Each rewritten file comes back as { path, lines, added, ' +
      'removed } — `lines` being where it changed in the NEW file ("12, 40-44"), so the ' +
      'line numbers still hold for a read or edit that follows. Not the diff text: the ' +
      'Changes panel holds that, and every rewrite is recorded there like any other edit. ' +
      'A file Prettier cannot parse is skipped with its syntax error and the rest still ' +
      'run — so a `skipped` entry after an edit is worth reading: it usually means that ' +
      'edit left the file unparseable, which no amount of type checking will phrase as ' +
      'clearly.',
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
      },
    },
    replay: 'never',
    run: async (p) => {
      const paths = Array.isArray(p.paths) ? p.paths.map(String) : undefined;
      const outcome = await formatFiles(paths);
      return {
        status: outcome.skipped.length > 0 ? 'partial' : 'success',
        ...outcome,
      };
    },
  }),
  manifest: defineAppCommand({
    description:
      'Compare the STATIC manifest (from the last compile) against the RUNTIME manifest ' +
      '(what the open preview actually registered), plus a drift report. Needs a compile ' +
      '(static side) and an open preview (runtime side).',
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
          ? 'Neither side is available — compile the project (static) and open a preview ' +
            '(runtime), then retry.'
          : !stat.names
            ? 'Only the runtime side is available, so no drift check was possible. ' +
              (stat.reason ?? '')
            : 'Only the static side is available, so no drift check was possible. ' +
              (runtime.reason ?? '');
      return { ...result, note: note.trim() };
    },
  }),
  deploy: defineAppCommand({
    description:
      'Deploy to apps/. Refuses type errors unless skipTypecheck, and refuses a manifest ' +
      'that drops commands the installed app has unless allowProtocolShrink. Snapshots the ' +
      'previous version — see gitRestore. Closes the preview window on success: it shows ' +
      'the pre-deploy build, so re-open it with `preview` if you still need it. ' +
      'A `staleWindow` in the result means you deployed the app you are running inside: ' +
      'that window was spared (closing it would have killed this call) and is STILL ' +
      'RUNNING THE OLD BUNDLE, so verifying the change in it reports the code from before ' +
      "the deploy. Reload it — invoke('yaar://windows/{staleWindow}', {action:'reload'}) — " +
      'which re-mounts the iframe without discarding its app agent. A deploy never ships the ' +
      'installed version number again: unless app.json `version` is already above the ' +
      'installed one, it is raised one patch step above the higher of the two and saved in ' +
      'the project. The result carries `version` (as deployed), `installedVersion`, and ' +
      '`bumped: { from, to, reason }` whenever it moved.',
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
            'Omit for the automatic rule above. true: always raise one patch step, even over ' +
            'a hand-set higher version. false: deploy app.json `version` as written, for a ' +
            'pure redeploy of an unchanged build. Any bump is reverted if the deploy fails.',
        },
      },
      required: ['appId'],
    },
    replay: 'never',
    run: async (p) =>
      await deploy({
        appId: String(p.appId),
        name: p.name ? String(p.name) : undefined,
        icon: p.icon ? String(p.icon) : undefined,
        description: p.description ? String(p.description) : undefined,
        message: p.message ? String(p.message) : undefined,
        skipTypecheck: p.skipTypecheck === true,
        allowProtocolShrink: p.allowProtocolShrink === true,
        bump: typeof p.bump === 'boolean' ? p.bump : undefined,
      }),
  }),
};
