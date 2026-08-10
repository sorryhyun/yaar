import { AppCommandError, errMsg, invoke, defineAppCommand } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../core';
import {
  captureFailureHint,
  inspectPreview,
  openPreview,
  previewEvaluate,
  previewStaleNote,
  queryPreviewState,
  readPreview,
} from '../services';

export const previewCommands = {
  preview: defineAppCommand({
    description: 'Open preview window for the compiled app.',
    params: { type: 'object', properties: {} },
    run: async () => await openPreview(),
  }),
  previewScreenshot: defineAppCommand({
    description:
      'Screenshot of the running preview. With `info: true`, also returns window ' +
      'geometry/size as a leading text block. Throws on capture failure with `reason`: ' +
      "'taint' | 'zero-size' | 'serialize-error' | 'no-provider' | 'no-response' | undefined. " +
      'A capture that succeeded while omitting content (an unreadable canvas, an image it ' +
      'could not inline, or a composite that fell back to the largest canvas alone) leads ' +
      'with a warning block naming what is missing — a blank region under such a warning ' +
      'is not evidence the app drew nothing there.',
    params: {
      type: 'object',
      properties: {
        info: { type: 'boolean', description: 'Also return window geometry/size.' },
      },
    },
    run: async (p) => {
      const { images, info } = await readPreview();
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
    run: async (p) => {
      const expression =
        typeof p.expression === 'string' ? p.expression : String(p.expression ?? '');
      if (!expression.trim()) throw new AppCommandError('expression is required.');
      const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined;
      return await previewEvaluate(expression, timeoutMs, { changed: p.changed === true });
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
      'key back whole.',
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
            'reads none, which is how to ask for the render and console alone.',
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
      if (p.stateKey !== undefined) {
        return await queryPreviewState(String(p.stateKey));
      }
      const keys = Array.isArray(p.keys) ? p.keys.map((k) => String(k)) : undefined;
      const selector = typeof p.selector === 'string' ? p.selector : undefined;
      return await inspectPreview({ ...(keys ? { keys } : {}), ...(selector ? { selector } : {}) });
    },
  }),
  previewCommand: defineAppCommand({
    description:
      'Send an app protocol command to the preview window. A command that takes longer than ' +
      "30s needs `timeoutMs` — and this command's own timeoutMs raised above it.",
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name' },
        params: { type: 'object', description: 'Command parameters' },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait for the preview app (default 30s, max 180s).',
        },
      },
      required: ['command'],
    },
    run: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      try {
        return await invoke(`yaar://windows/${wid}`, {
          action: 'app_command',
          command: String(p.command),
          params: (p.params as Record<string, unknown>) ?? {},
          ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}),
        });
      } catch (err) {
        throw new AppCommandError(`Preview command failed: ${errMsg(err)}`);
      }
    },
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
