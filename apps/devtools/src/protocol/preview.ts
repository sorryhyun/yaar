import { AppCommandError, errMsg, invoke, defineAppCommand, wait } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../core';
import {
  captureFailureHint,
  cropToSelector,
  inspectPreview,
  openPreview,
  previewEvaluate,
  previewFaultsNote,
  previewStateSizes,
  setPreviewFaults,
  previewStaleNote,
  queryPreviewState,
  readPreview,
  readPreviewConsole,
  previewMountErrors,
  runPreviewScript,
  samplePreviewState,
} from '../services';
import { innerWaitMs } from '../lib';
import { imageBlocks, imagesFromReadResult, type ReadBlock } from './read-blocks';

const CAPTURE_TOO_LARGE = 'ask the command for a smaller capture';

/**
 * A command that answers with images comes back from the SDK's `invoke` as
 * `{ data, images }`. Returned as that object it reaches the agent as JSON, base64 and
 * all (one 1440px captureSlide was ~180k tokens of text), so the images are lifted back
 * out into image blocks, which the app protocol passes through. `data` is what the
 * command said beside them, and leads.
 */
function liftImages(label: string, result: unknown): { data: unknown; blocks: ReadBlock[] } | null {
  const withImages = imagesFromReadResult(result);
  if (!withImages) return null;
  return {
    data: (result as { data?: unknown }).data,
    blocks: imageBlocks(label, withImages.images, CAPTURE_TOO_LARGE),
  };
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export const previewCommands = {
  'preview/open': defineAppCommand({
    description:
      'Open or remount the preview on the last compile; resets in-app state (read the ' +
      '`previewOpen` state key first). `previewErrors` ({ count, first }) is what it logged ' +
      'as an error while mounting; absent means none so far.',
    params: { type: 'object', properties: {} },
    run: async () => {
      const opened = await openPreview();
      const faults = previewFaultsNote();
      await wait(800); // the mount, as build/compile waits for it
      const previewErrors = await previewMountErrors();
      return {
        ...opened,
        ...(faults ? { faults } : {}),
        ...(previewErrors ? { previewErrors } : {}),
      };
    },
  }),
  'preview/screenshot': defineAppCommand({
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
  'preview/eval': defineAppCommand({
    description:
      "Evaluate a JS expression in the preview iframe's global scope; awaited if a promise. " +
      'TS syntax is stripped; a top-level `await` runs in an async wrapper, so its `const`s ' +
      'stay local to that call. Module scope is reachable only as `__debug` (the ' +
      'preview-debugging topic). Result is JSON-serialized and capped at 16KB. Preview ' +
      'windows only. Slower than 5s needs `waitMs` (the timeouts topic). With ' +
      '`changed: true` the return becomes { result, changed, dom? } — what the expression ' +
      'moved, diffed against a snapshot taken just before it ran (preview/query already ' +
      'diffs state and DOM, cheaper).',
    params: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'JS expression, e.g. "document.querySelectorAll(\'.row\').length" or ' +
            '"getComputedStyle(document.querySelector(\'#app\')).height"',
        },
        waitMs: {
          type: 'number',
          description:
            'Inner wait for the expression to settle (default 5s, floor 1s, max 180s). Raise ' +
            'it for an expression that awaits a promise, sleeps, or waits on a render.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Older name for `waitMs`, which wins when both are passed.',
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
      return await previewEvaluate(expression, innerWaitMs(p), { changed: p.changed === true });
    },
  }),
  'preview/faults': defineAppCommand({
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
        throw new AppCommandError(`preview/faults failed: ${errMsg(err)}`);
      }
    },
  }),
  'preview/query': defineAppCommand({
    description:
      'Read the running preview — the cheap first look, before preview/eval. With no ' +
      '`stateKey`: every declared state value (decoded, not JSON text), the rendered text, ' +
      'the console tail, `stateSizes` (chars per key, largest first) and `changed`, a diff ' +
      'against the previous snapshot (absent on the first call after a preview opens: ' +
      'unknown, not unchanged). State that disagrees with the rendered text is a reactivity ' +
      'bug. A value past 2000 chars stays cut text with `truncated` and `chars`; a key past ' +
      'the snapshot budget is named in `stateOmitted`. `stateKey` reads one key whole, ' +
      '`sizes: true` returns only the sizes.',
    params: {
      type: 'object',
      properties: {
        stateKey: {
          type: 'string',
          description:
            'Read this one key, untruncated, and return its value alone. Omit for the ' +
            'full snapshot.',
        },
        sizes: {
          type: 'boolean',
          description:
            'Snapshot mode: return only `stateSizes`, to choose what to read next. Leaves ' +
            'the `changed` baseline alone. With `keys`, only those keys.',
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
            'activity first (preview/command), then sample.',
        },
        durationMs: {
          type: 'number',
          description:
            'How long to sample (max 120s, at most 300 samples). Past ~25s raise the host ' +
            'wait (the timeouts topic).',
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
      if (p.sizes === true) return await previewStateSizes(keys);
      const selector = typeof p.selector === 'string' ? p.selector : undefined;
      return await inspectPreview({ ...(keys ? { keys } : {}), ...(selector ? { selector } : {}) });
    },
  }),
  'preview/console': defineAppCommand({
    description:
      'Console output from the preview app: { connected, logs, filtered? } — `filtered` ' +
      'counting the entries the filters dropped. `connected: false` means the preview ' +
      'buffer could not be read, and an empty `logs` then says nothing about whether the ' +
      'app logged anything. Only the app\'s own output by default; `source: "all"` ' +
      'interleaves the Dev Tools audit entries (preview/eval inputs and results, fault-rule ' +
      'changes), collapsed to one line each unless `full`. `preview/query` also carries ' +
      'the tail.',
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
          description:
            "app (default): the preview's own output. devtools: the audit entries. all: both.",
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
  'preview/command': defineAppCommand({
    description:
      'Send an app protocol command to the preview window — or, with `batch`, several in ' +
      'order, stopping at the first that fails unless `keepGoing`. A command slower than 30s ' +
      'needs `waitMs`, and a batch a host wait past the sum (the timeouts topic).',
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
        },
        keepGoing: {
          type: 'boolean',
          description:
            'With `batch`: run every step whatever fails and report the count as `failed`. ' +
            'For probing several bad inputs in one call. Steps share one app, so an earlier ' +
            'step can leave state a later one sees.',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['command'],
          },
        },
        waitMs: {
          type: 'number',
          description: 'Inner wait per command (default 30s, floor 1s, max 180s).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Older name for `waitMs`, which wins when both are passed.',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview/open first.');
      const waitMs = innerWaitMs(p);
      const send = (command: string, params: unknown) =>
        invoke(`yaar://windows/${wid}`, {
          action: 'app_command',
          command,
          params: (params as Record<string, unknown>) ?? {},
          ...(waitMs !== undefined ? { timeoutMs: waitMs } : {}),
        });
      if (p.batch !== undefined) {
        if (p.command !== undefined) {
          throw new AppCommandError('Pass `command` or `batch`, not both.');
        }
        if (!Array.isArray(p.batch) || p.batch.length === 0) {
          throw new AppCommandError('batch must be a non-empty array of { command, params }.');
        }
        const keepGoing = p.keepGoing === true;
        const steps: { command: string; result?: unknown; error?: string }[] = [];
        const images: ReadBlock[] = [];
        // Steps stay one JSON block; a step's images follow it, labelled with its number.
        const done = (value: object) =>
          images.length > 0 ? [{ type: 'text', text: asText(value) }, ...images] : value;
        for (const step of p.batch as { command?: unknown; params?: unknown }[]) {
          const command = String(step?.command ?? '');
          try {
            const result = await send(command, step?.params);
            const lifted = liftImages(`step ${steps.length + 1}: ${command}`, result);
            if (lifted) images.push(...lifted.blocks);
            steps.push({ command, result: lifted ? lifted.data : result });
          } catch (err) {
            steps.push({ command, error: errMsg(err) });
            if (keepGoing) continue;
            return done({
              steps,
              stopped: `Step ${steps.length} of ${p.batch.length} failed; the rest did not run.`,
            });
          }
        }
        return done(
          keepGoing
            ? { steps, failed: steps.filter((s) => s.error !== undefined).length }
            : { steps },
        );
      }
      if (typeof p.command !== 'string' || !p.command) {
        throw new AppCommandError('command is required (or pass `batch`).');
      }
      let result: unknown;
      try {
        result = await send(p.command, p.params);
      } catch (err) {
        throw new AppCommandError(`Preview command failed: ${errMsg(err)}`);
      }
      const lifted = liftImages(p.command, result);
      if (!lifted) return result;
      const lead =
        lifted.data === undefined || lifted.data === ''
          ? []
          : [{ type: 'text', text: asText(lifted.data) }];
      return [...lead, ...lifted.blocks];
    },
  }),
  'preview/script': defineAppCommand({
    description:
      'Run a scripted regression: execute the steps in a JSON script file from the project ' +
      'against the open preview — protocol commands, state-key reads, JS evals and window ' +
      "resizes — record each result (projected through the step's `pick` " +
      "paths), and diff against the script's baseline file — failures come back as " +
      '{ step, expected, actual } rows; with no baseline yet, the run writes one. Requires an ' +
      'open, non-stale preview on the current compile, and a host wait past the sum of its ' +
      'steps (the timeouts topic). `realStorageWrites` lists real files the run changed ' +
      'outside preview storage and `storageWarning` says what to do. Script format and ' +
      'workflow: the regression-testing topic.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Script file in the project. Default src/test/regression.json; keep it under src/ ' +
            '(the app-structure topic).',
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
            'Row LABELS, not the step objects of the script file: with update: true, rewrite ' +
            'only these rows (a repeated label is "label (2)") and keep the rest of the ' +
            'baseline. The other rows are still compared and reported as `failures`.',
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
  'preview/resize': defineAppCommand({
    description:
      'Resize the preview window to width × height pixels. Unlike `preview/open`, this does not ' +
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
      if (!wid) throw new AppCommandError('No preview window open. Run preview/open first.');
      const width = Number(p.width);
      const height = Number(p.height);
      if (!(width > 0) || !(height > 0)) {
        throw new AppCommandError('width and height must be positive numbers.');
      }
      try {
        return await invoke(`yaar://windows/${wid}`, { action: 'resize', width, height });
      } catch {
        setPreviewWindowId(null);
        throw new AppCommandError('Preview window no longer exists. Run preview/open first.');
      }
    },
  }),
};
