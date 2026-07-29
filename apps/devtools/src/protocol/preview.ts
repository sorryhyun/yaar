import { AppCommandError, errMsg, invoke, defineAppCommand } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../core';
import {
  captureFailureHint,
  inspectPreview,
  openPreview,
  previewEvaluate,
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
      "'taint' | 'zero-size' | 'serialize-error' | 'no-provider' | 'no-response' | undefined.",
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
      return p.info === true
        ? [{ type: 'text', text: JSON.stringify(info, null, 2) }, ...imageBlocks]
        : imageBlocks;
    },
  }),
  previewEval: defineAppCommand({
    description:
      "Evaluate a JS expression in the preview iframe's global scope; awaited if a promise. " +
      'Result is JSON-serialized and capped at 16KB. Preview windows only. An expression ' +
      "that awaits or sleeps for more than 5s needs `timeoutMs` — and this command's own " +
      'timeoutMs raised above it, or that one expires first.',
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
      },
      required: ['expression'],
    },
    run: async (p) => {
      const expression =
        typeof p.expression === 'string' ? p.expression : String(p.expression ?? '');
      if (!expression.trim()) throw new AppCommandError('expression is required.');
      const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined;
      return await previewEvaluate(expression, timeoutMs);
    },
  }),
  previewInspect: defineAppCommand({
    description:
      'One snapshot of the running preview: every declared protocol state value, the text the ' +
      'DOM is actually rendering, and the console tail — plus `changed`, a diff against the ' +
      'previous inspect (absent on the first call after a preview opens). Reach for this before ' +
      'previewQuery/previewEval when a bug is unlocated: state that disagrees with the rendered ' +
      'text is a reactivity bug, not a state bug. Per-key errors are isolated; values are ' +
      'truncated and any key dropped for budget is named in `stateOmitted`.',
    params: { type: 'object', properties: {} },
    run: async () => await inspectPreview(),
  }),
  previewQuery: defineAppCommand({
    description:
      'Query one app protocol state key from the preview window. For an unlocated bug prefer ' +
      'previewInspect, which returns every key alongside the rendered DOM.',
    params: {
      type: 'object',
      properties: { stateKey: { type: 'string', description: 'State key to query' } },
      required: ['stateKey'],
    },
    run: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      try {
        return await invoke(`yaar://windows/${wid}`, {
          action: 'app_query',
          stateKey: String(p.stateKey),
        });
      } catch (err) {
        throw new AppCommandError(`Preview query failed: ${errMsg(err)}`);
      }
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
