import { AppCommandError, errMsg, invoke, defineAppCommand } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../core';
import {
  captureFailureHint,
  cropToSelector,
  inspectPreview,
  openPreview,
  previewEvaluate,
  previewFaultsNote,
  setPreviewFaults,
  previewStaleNote,
  queryPreviewState,
  readPreview,
  readPreviewConsole,
  runPreviewScript,
  samplePreviewState,
} from '../services';

export const previewCommands = {
  preview: defineAppCommand({
    description: 'Open preview window for the compiled app.',
    params: { type: 'object', properties: {} },
    run: async () => {
      const opened = await openPreview();
      const faults = previewFaultsNote();
      return faults ? { ...opened, faults } : opened;
    },
  }),
  previewScreenshot: defineAppCommand({
    description:
      'Screenshot of the running preview. With `info: true`, also returns window ' +
      'geometry/size as a leading text block. Throws on capture failure with `reason`: ' +
      "'taint' | 'zero-size' | 'serialize-error' | 'no-provider' | 'no-response' | undefined. " +
      'A capture that succeeded while omitting content (an unreadable canvas, an image it ' +
      'could not inline, or a composite that fell back to the largest canvas alone) leads ' +
      'with a warning block naming what is missing — a blank region under such a warning ' +
      'is not evidence the app drew nothing there. With `selector`, the image is cropped to ' +
      'that element (a selector matching nothing is an error).',
    params: {
      type: 'object',
      properties: {
        info: { type: 'boolean', description: 'Also return window geometry/size.' },
        selector: {
          type: 'string',
          description: 'CSS selector; crop the screenshot to the first matching element.',
        },
      },
    },
    run: async (p) => {
      const read = await readPreview();
      const info = read.info;
      let images = read.images;
      let cropNote: string | undefined;
      if (typeof p.selector === 'string' && p.selector.trim() && images.length > 0) {
        const cropped = await cropToSelector(images[0], p.selector);
        images = [cropped.image];
        cropNote = cropped.note;
      }
      if (images.length === 0) {
        // The server reports *why* the capture produced nothing (window.ts attaches
        // captureFailure). Pass that through with its recovery hint rather than
        // guessing "not painted yet", which was wrong for every cause but one.
        const reason = typeof info.captureFailure === 'string' ? info.captureFailure : undefined;
        throw new AppCommandError(
          reason
            ? `Preview screenshot failed: ${reason}. ${captureFailureHint(reason)}`
            : 'Preview window returned no screenshot, and the capture reported no reason. ' +
                'The window may have just been created — give it a moment, then retry.',
        );
      }
      // Content blocks pass through to the agent untouched (wrapAppValue), so the
      // image arrives as an image and not as a wall of base64.
      const imageBlocks = images.map((img) => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      }));
      // Two ways a screenshot can be true of nothing you care about: it pictures an
      // older build, or the capture dropped part of the picture. Both lead, and both
      // regardless of `info` — they are not extra detail, they are how to read the
      // image below them.
      const warnings: string[] = [];
      const stale = previewStaleNote();
      if (stale) warnings.push(stale);
      if (cropNote) warnings.push(cropNote);
      const degraded = info.captureDegraded;
      if (Array.isArray(degraded) && degraded.length > 0) {
        warnings.push(
          'INCOMPLETE CAPTURE: the screenshot succeeded but left content out:\n' +
            degraded.map((n) => `- ${String(n)}`).join('\n') +
            '\nA blank region here may be the capture, not the app. An app that paints ' +
            'imperatively can supply its own image via defineApp({ onCapture }).',
        );
      }
      return [
        ...(warnings.length > 0 ? [{ type: 'text', text: warnings.join('\n\n') }] : []),
        ...(p.info === true ? [{ type: 'text', text: JSON.stringify(info, null, 2) }] : []),
        ...imageBlocks,
      ];
    },
  }),
  previewEval: defineAppCommand({
    description:
      "Evaluate a JS expression in the preview iframe's global scope; awaited if a promise. " +
      'Module scope is not on the global: what the app declares in `defineApp({ debug })` is ' +
      'reachable as `__debug` (preview only, never deployed). ' +
      'Result is JSON-serialized and capped at 16KB. Preview windows only. An expression ' +
      "that awaits or sleeps for more than 5s needs `timeoutMs` — and this command's own " +
      'timeoutMs raised above it, or that one expires first. With `changed: true` the ' +
      'return becomes { result, changed, dom? } — what the expression moved, diffed against ' +
      'a snapshot taken just before it ran.',
    params: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'JS expression, e.g. "document.querySelectorAll(\'.row\').length" or ' +
            '"getComputedStyle(document.querySelector(\'#app\')).height"',
        },
        timeoutMs: {
          type: 'number',
          description:
            'How long to wait for the expression to settle (default 5s, max 180s). Raise it ' +
            'for an expression that awaits a promise, sleeps, or waits on a render.',
        },
        changed: {
          type: 'boolean',
          description:
            'Snapshot declared state and rendered text before and after, and return what ' +
            'moved: { result, changed: { state: { key: { from, to } }, dom }, dom? } — `dom` ' +
            'carrying the new rendered text only when it changed. Use for an expression run ' +
            'to *cause* something (a click, a fetch); an empty diff is then the finding. ' +
            'Costs two extra round trips, so leave it off for a plain read.',
        },
      },
      required: ['expression'],
    },
    replay: 'never',
    run: async (p) => {
      const expression =
        typeof p.expression === 'string' ? p.expression : String(p.expression ?? '');
      if (!expression.trim()) throw new AppCommandError('expression is required.');
      const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined;
      return await previewEvaluate(expression, timeoutMs, { changed: p.changed === true });
    },
  }),
  previewFaults: defineAppCommand({
    description:
      "Make the preview's own verb and cross-origin fetch calls fail, stall or hang, to " +
      'exercise error and loading paths. `rules` replaces the whole list ([] clears it); ' +
      'omit it to read the rules back with how many calls each has caught — 0 hits means ' +
      'the app never made the call you meant to break. Rules are enforced by the server, so ' +
      'they survive reloads and every compile, and catch the calls an app makes while it ' +
      "boots. Same-origin relative fetches and the app agent's own calls are not covered.",
    params: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          description:
            'First matching rule wins. Each: { match, kind, verbs?, status?, error?, ' +
            'retryable?, delayMs?, times? }.',
          items: {
            type: 'object',
            properties: {
              match: {
                type: 'string',
                description:
                  'A yaar:// URI for verb calls or an http(s) URL for fetches; * matches ' +
                  'any run of characters. "yaar://apps/self/storage/*" matches by the ' +
                  'spelling the app used, so does the resolved ' +
                  '"yaar://apps/preview--{projectId}/storage/*".',
              },
              kind: {
                type: 'string',
                enum: ['fail', 'delay', 'hang'],
                description:
                  'fail: the call errors the way a real failure does. delay: it runs ' +
                  'after delayMs. hang: it never answers until the app gives up (capped ' +
                  'at 240s).',
              },
              verbs: {
                type: 'array',
                items: { type: 'string', enum: ['describe', 'read', 'list', 'invoke', 'delete'] },
                description: 'yaar:// rules only: catch just these verbs.',
              },
              status: { type: 'number', description: 'fail: HTTP status, 400-599.' },
              error: { type: 'string', description: 'fail: the error message the app sees.' },
              retryable: {
                type: 'boolean',
                description:
                  'fail on a verb: answer the retryable 503 the SDK retries (twice, over ' +
                  '~4s) before throwing. Pair with times to test recovery.',
              },
              delayMs: {
                type: 'number',
                description: 'Required for delay. On fail, how long to stall first.',
              },
              times: {
                type: 'number',
                description: 'Stop after this many hits — times: 1 breaks only the first call.',
              },
            },
            required: ['match', 'kind'],
          },
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      if (p.rules !== undefined && !Array.isArray(p.rules)) {
        throw new AppCommandError('rules must be an array (pass [] to clear).');
      }
      try {
        return await setPreviewFaults(p.rules as unknown[] | undefined);
      } catch (err) {
        throw new AppCommandError(`previewFaults failed: ${errMsg(err)}`);
      }
    },
  }),
  previewQuery: defineAppCommand({
    description:
      'Read the running preview. With no `stateKey` this is the inspect snapshot: every ' +
      'declared protocol state value, the text the DOM is actually rendering, the console ' +
      'tail, and `changed` — a diff against the previous snapshot (absent on the first call ' +
      'after a preview opens, which means unknown, not unchanged). Start here when a bug is ' +
      'unlocated: state that disagrees with the rendered text is a reactivity bug, not a ' +
      'state bug, and one call already makes that comparison. Snapshot values are truncated ' +
      'and any key dropped for budget is named in `stateOmitted`; pass `stateKey` to read one ' +
      'key back whole, `keys` with it to read only some of its fields, and `sampleEveryMs` ' +
      '+ `durationMs` to watch it over time instead of reading it once.',
    params: {
      type: 'object',
      properties: {
        stateKey: {
          type: 'string',
          description:
            'Read this one key, untruncated, and return its value alone. Omit for the ' +
            'full snapshot.',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Snapshot mode: read only these state keys instead of every declared one. `[]` ' +
            'reads none, which is how to ask for the render and console alone. With ' +
            '`stateKey`: return only these top-level fields of its value — a field it lacks ' +
            'is an error naming the ones it has.',
        },
        sampleEveryMs: {
          type: 'number',
          description:
            'With `stateKey` and `durationMs`: read the key every this many ms (min 16) and ' +
            'return { samples, elapsedMs, numeric: { "path.to.leaf": { min, max, last, n } }, ' +
            'last } — for values that only mean something while the app runs (meters, a ' +
            'playhead). Each read is a round trip, so the interval is a floor. Start the ' +
            'activity first (previewCommand), then sample.',
        },
        durationMs: {
          type: 'number',
          description:
            "How long to sample (max 120s, at most 300 samples). Past ~25s raise this command's " +
            'own timeoutMs above it.',
        },
        series: {
          type: 'boolean',
          description: 'Sampling: also return every sample as `series: [{ t, value }]`.',
        },
        selector: {
          type: 'string',
          description:
            'Snapshot mode: read rendered text from this CSS selector instead of the whole ' +
            'app. A selector matching nothing is reported as an error, not as empty text.',
        },
      },
    },
    run: async (p) => {
      const keys = Array.isArray(p.keys) ? p.keys.map((k) => String(k)) : undefined;
      const sampling = p.sampleEveryMs !== undefined || p.durationMs !== undefined;
      if (p.stateKey !== undefined) {
        const stateKey = String(p.stateKey);
        if (!sampling) return await queryPreviewState(stateKey, keys);
        return await samplePreviewState(stateKey, {
          everyMs: Number(p.sampleEveryMs),
          durationMs: Number(p.durationMs),
          ...(keys ? { fields: keys } : {}),
          ...(p.series === true ? { series: true } : {}),
        });
      }
      if (sampling) {
        throw new AppCommandError('sampleEveryMs/durationMs sample one key: pass `stateKey` too.');
      }
      const selector = typeof p.selector === 'string' ? p.selector : undefined;
      return await inspectPreview({ ...(keys ? { keys } : {}), ...(selector ? { selector } : {}) });
    },
  }),
  previewConsole: defineAppCommand({
    description:
      'The consoleLogs read, filtered: { connected, logs, filtered? } — `filtered` counting ' +
      'the entries the filters dropped. Audit entries (previewEval inputs and results, ' +
      'fault-rule changes) stay collapsed to one line unless `full`.',
    params: {
      type: 'object',
      properties: {
        levels: {
          type: 'array',
          items: { type: 'string', enum: ['log', 'info', 'warn', 'error'] },
          description: 'Keep only these levels. Uncaught errors are logged as error.',
        },
        source: {
          type: 'string',
          enum: ['app', 'devtools', 'all'],
          description: "app: the preview's own output. devtools: the audit entries. Default all.",
        },
        limit: { type: 'number', description: 'Newest N entries (default and max 200).' },
        full: { type: 'boolean', description: 'Return audit entries whole.' },
      },
    },
    run: async (p) =>
      await readPreviewConsole({
        ...(Array.isArray(p.levels) ? { levels: p.levels.map((l) => String(l)) } : {}),
        ...(p.source === 'app' || p.source === 'devtools' || p.source === 'all'
          ? { source: p.source }
          : {}),
        ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
        ...(p.full === true ? { full: true } : {}),
      }),
  }),
  previewCommand: defineAppCommand({
    description:
      'Send an app protocol command to the preview window — or, with `batch`, several in ' +
      'order, stopping at the first that fails. A command that takes longer than 30s needs ' +
      "`timeoutMs` — and this command's own timeoutMs raised above it (above the sum, for " +
      'a batch).',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name' },
        params: { type: 'object', description: 'Command parameters' },
        batch: {
          type: 'array',
          description:
            'Instead of `command`: run these in order and return { steps: [{ command, ' +
            'result }], stopped? } — a failing step carries `error` in place of `result`, ' +
            'nothing after it runs, and `stopped` says so. For setup sequences (mute these ' +
            'tracks, set that mix) that would otherwise be one call each.',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['command'],
          },
        },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait for the preview app, per command (default 30s, max 180s).',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      const send = (command: string, params: unknown) =>
        invoke(`yaar://windows/${wid}`, {
          action: 'app_command',
          command,
          params: (params as Record<string, unknown>) ?? {},
          ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}),
        });
      if (p.batch !== undefined) {
        if (p.command !== undefined) {
          throw new AppCommandError('Pass `command` or `batch`, not both.');
        }
        if (!Array.isArray(p.batch) || p.batch.length === 0) {
          throw new AppCommandError('batch must be a non-empty array of { command, params }.');
        }
        const steps: { command: string; result?: unknown; error?: string }[] = [];
        for (const step of p.batch as { command?: unknown; params?: unknown }[]) {
          const command = String(step?.command ?? '');
          try {
            steps.push({ command, result: await send(command, step?.params) });
          } catch (err) {
            steps.push({ command, error: errMsg(err) });
            return {
              steps,
              stopped: `Step ${steps.length} of ${p.batch.length} failed; the rest did not run.`,
            };
          }
        }
        return { steps };
      }
      if (typeof p.command !== 'string' || !p.command) {
        throw new AppCommandError('command is required (or pass `batch`).');
      }
      try {
        return await send(p.command, p.params);
      } catch (err) {
        throw new AppCommandError(`Preview command failed: ${errMsg(err)}`);
      }
    },
  }),
  previewScript: defineAppCommand({
    description:
      'Run a scripted regression: execute the steps in a JSON script file from the project ' +
      'against the open preview — protocol commands, state-key reads, JS evals and window ' +
      "resizes — record each result (projected through the step's `pick` " +
      "paths), and diff against the script's baseline file — failures come back as " +
      '{ step, expected, actual } rows; with no baseline yet, the run writes one. Requires an ' +
      "open, non-stale preview on the current compile, and this command's own timeoutMs " +
      'raised past the sum of its steps. Script format and workflow: the regression-testing ' +
      'doc topic.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Script file in the project. Default src/test/regression.json — keep it under ' +
            'src/, since deploy ships only src/, agent/ and the root files.',
        },
        update: {
          type: 'boolean',
          description:
            'Rewrite the baseline from this run and report the delta by label: `changed` for ' +
            'a value that moved, `added`/`removed` for steps the script gained or lost. ' +
            'Works after a script edit too — it is how a structureMismatch is resolved. Only ' +
            'after verifying the new behavior is intended: an updated baseline is the new truth.',
        },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Run only steps in these groups (ungrouped steps still run). The comparison ' +
            'then covers only what ran. Incompatible with a full update; fine with `steps`.',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'With update: true, rewrite only these rows (by step label; a repeated label is ' +
            '"label (2)") and keep the rest of the baseline. The other rows are still compared ' +
            'and reported as `failures`.',
        },
      },
    },
    replay: 'never',
    run: async (p) =>
      await runPreviewScript({
        ...(typeof p.path === 'string' ? { path: p.path } : {}),
        ...(p.update === true ? { update: true } : {}),
        ...(Array.isArray(p.groups) ? { groups: p.groups.map((g) => String(g)) } : {}),
        ...(Array.isArray(p.steps) ? { steps: p.steps.map((s) => String(s)) } : {}),
      }),
  }),
  resizePreview: defineAppCommand({
    description:
      'Resize the preview window to width × height pixels. Unlike `preview`, this does not ' +
      'remount the iframe, so preview state is kept.',
    params: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'New width in pixels' },
        height: { type: 'number', description: 'New height in pixels' },
      },
      required: ['width', 'height'],
    },
    run: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      const width = Number(p.width);
      const height = Number(p.height);
      if (!(width > 0) || !(height > 0)) {
        throw new AppCommandError('width and height must be positive numbers.');
      }
      try {
        return await invoke(`yaar://windows/${wid}`, { action: 'resize', width, height });
      } catch {
        setPreviewWindowId(null);
        throw new AppCommandError('Preview window no longer exists. Run preview first.');
      }
    },
  }),
};
