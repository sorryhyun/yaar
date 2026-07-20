import { AppCommandError, defineCommand, errMsg, invoke } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../project';
import { captureFailureHint, openPreview, previewEvaluate, readPreview } from '../preview';

export const previewCommands = {
  preview: defineCommand({
    description: 'Open preview window for the compiled app.',
    params: { type: 'object', properties: {} },
    handler: async () => await openPreview(),
  }),
  previewScreenshot: defineCommand({
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
    handler: async (p) => {
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
  previewEval: defineCommand({
    description:
      "Evaluate a JS expression in the preview iframe's global scope; awaited if a promise. " +
      'Result is JSON-serialized and capped at 16KB. Preview windows only.',
    params: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'JS expression, e.g. "document.querySelectorAll(\'.row\').length" or ' +
            '"getComputedStyle(document.querySelector(\'#app\')).height"',
        },
      },
      required: ['expression'],
    },
    handler: async (p) => {
      const expression = String(p.expression ?? '').trim();
      if (!expression) throw new AppCommandError('expression is required.');
      return await previewEvaluate(expression);
    },
  }),
  previewQuery: defineCommand({
    description: 'Query app protocol state from the preview window.',
    params: {
      type: 'object',
      properties: { stateKey: { type: 'string', description: 'State key to query' } },
      required: ['stateKey'],
    },
    handler: async (p) => {
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
  previewCommand: defineCommand({
    description: 'Send an app protocol command to the preview window.',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name' },
        params: { type: 'object', description: 'Command parameters' },
      },
      required: ['command'],
    },
    handler: async (p) => {
      const wid = previewWindowId();
      if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
      try {
        return await invoke(`yaar://windows/${wid}`, {
          action: 'app_command',
          command: String(p.command),
          params: (p.params as Record<string, unknown>) ?? {},
        });
      } catch (err) {
        throw new AppCommandError(`Preview command failed: ${errMsg(err)}`);
      }
    },
  }),
  resizePreview: defineCommand({
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
    handler: async (p) => {
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
