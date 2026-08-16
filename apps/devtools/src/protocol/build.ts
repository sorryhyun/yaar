import { wait, defineAppCommand } from '@bundled/yaar';
import {
  diagnostics,
  bundleStatus,
  compileErrors,
  previewUrl,
  previewWindowId,
  staticProtocol,
} from '../core';
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
      // Typecheck and compile were always run back-to-back as two round trips, and compiling
      // does not typecheck — so it was easy to ship code that built but never type checked.
      // Fold them: check first, build regardless, report both.
      const skip = p.skipTypecheck === true;
      if (!skip) await typecheck();
      await compile();
      const built = bundleStatus() === 'success';
      const errors = compileErrors();
      const diags = skip ? [] : diagnostics();
      const typeErrors = diags.filter((d) => d.severity === 'error').length;

      // A bundle that built around two type errors used to come back `status: "success"`
      // with a previewUrl — the one word the caller reads, saying the one thing that
      // wasn't true. Bun strips types and builds happily through them, so "it built" and
      // "it type checks" are separate facts and both get reported: `built` for the
      // bundle, `status` for the code. Deploy enforces the same line.
      //
      // `skipTypecheck` gets its own word rather than borrowing `success`: nothing here
      // checked the code, and the `compileStatus` state key says the same thing so a
      // caller polling it cannot land on a cleaner answer than the command gave.
      const status = !built ? 'error' : skip ? 'unchecked' : typeErrors === 0 ? 'success' : 'error';

      // Refresh an open preview onto the build we just made. Left alone, it went on
      // showing the previous one — so a screenshot taken to confirm a fix showed the
      // code from before the fix, and agreed with you. Re-opening remounts the iframe,
      // which resets app state: a new build is a new app.
      //
      // That remount is the whole cost of a build for an app whose state took several
      // interactions to establish, so it is now declinable — but only because the
      // silent half of the original failure is closed: with `refreshPreview: false`
      // the window is *marked* stale (previewIsStale), and every preview read leads
      // with that. A stale preview you know about is a tradeoff; the one you don't is
      // the bug this comment was written for.
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
      'which re-mounts the iframe without discarding its app agent.',
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
      },
      required: ['appId'],
    },
    run: async (p) =>
      await deploy({
        appId: String(p.appId),
        name: p.name ? String(p.name) : undefined,
        icon: p.icon ? String(p.icon) : undefined,
        description: p.description ? String(p.description) : undefined,
        message: p.message ? String(p.message) : undefined,
        skipTypecheck: p.skipTypecheck === true,
        allowProtocolShrink: p.allowProtocolShrink === true,
      }),
  }),
};
