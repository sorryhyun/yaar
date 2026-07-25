import { AppCommandError, defineCommand, invoke, wait } from '@bundled/yaar';
import {
  diagnostics,
  compileStatus,
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
  getStaticManifest,
  getRuntimeManifest,
  diffManifestNames,
} from '../services';

export const buildCommands = {
  compile: defineCommand({
    description:
      'Type check and compile the active project; refreshes the preview window if one is ' +
      'open. `built` reflects the bundle, `status` reflects type checking — they can ' +
      'differ. Slow: pass timeoutMs (e.g. 60000).',
    params: {
      type: 'object',
      properties: {
        skipTypecheck: {
          type: 'boolean',
          description: 'Build without type checking first. Faster, but ships blind.',
        },
      },
    },
    handler: async (p) => {
      // Typecheck and compile were always run back-to-back as two round trips, and compiling
      // does not typecheck — so it was easy to ship code that built but never type checked.
      // Fold them: check first, build regardless, report both.
      const skip = p.skipTypecheck === true;
      if (!skip) await typecheck();
      await compile();
      const built = compileStatus() === 'success';
      const errors = compileErrors();
      const diags = skip ? [] : diagnostics();
      const typeErrors = diags.filter((d) => d.severity === 'error').length;

      // A bundle that built around two type errors used to come back `status: "success"`
      // with a previewUrl — the one word the caller reads, saying the one thing that
      // wasn't true. Bun strips types and builds happily through them, so "it built" and
      // "it type checks" are separate facts and both get reported: `built` for the
      // bundle, `status` for the code. Deploy enforces the same line.
      const status = built && typeErrors === 0 ? 'success' : 'error';

      // Refresh an open preview onto the build we just made. Left alone, it went on
      // showing the previous one — so a screenshot taken to confirm a fix showed the
      // code from before the fix, and agreed with you. Re-opening remounts the iframe,
      // which resets app state: a new build is a new app.
      let previewRefreshed = false;
      if (built && previewWindowId()) {
        await openPreview();
        previewRefreshed = true;
      }

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
  manifest: defineCommand({
    description:
      'Compare the STATIC manifest (from the last compile) against the RUNTIME manifest ' +
      '(what the open preview actually registered), plus a drift report. Needs a compile ' +
      '(static side) and an open preview (runtime side).',
    params: { type: 'object', properties: {} },
    handler: async () => {
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
  protocolLog: defineCommand({
    description:
      'App Protocol traffic for the preview window: every query/command sent and event ' +
      'emitted, in order, with results and timings.',
    params: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, newest last (default 100).' },
      },
    },
    handler: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      return await invoke(`yaar://windows/${wid}`, {
        action: 'protocol_log',
        ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
      });
    },
  }),
  deploy: defineCommand({
    description:
      'Deploy to apps/. Refuses type errors unless skipTypecheck, and refuses a manifest ' +
      'that drops commands the installed app has unless allowProtocolShrink. Snapshots the ' +
      'previous version — see gitRestore. Closes the preview window on success: it shows ' +
      'the pre-deploy build, so re-open it with `preview` if you still need it.',
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
    handler: async (p) =>
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
