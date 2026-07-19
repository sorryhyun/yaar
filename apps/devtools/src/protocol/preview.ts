import { AppCommandError, defineCommand, errMsg, invoke } from '@bundled/yaar';
import { previewWindowId, setPreviewWindowId } from '../project';
import { openPreview, readPreview } from '../preview';

export const previewCommands = {
  preview: defineCommand({
    description: 'Open preview window for the compiled app',
    params: { type: 'object', properties: {} },
    handler: async () => await openPreview(),
  }),
  viewPreview: defineCommand({
    description:
      'Read the preview window: a screenshot of what is actually on screen, plus its ' +
      'size and position. Look at the picture before theorizing about a rendering bug.',
    params: { type: 'object', properties: {} },
    handler: async () => {
      const { info, images } = await readPreview();
      // Content blocks pass through to the agent untouched (wrapAppValue), so the
      // image arrives as an image and not as a wall of base64.
      return [
        { type: 'text', text: JSON.stringify(info, null, 2) },
        ...images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
      ];
    },
  }),
  previewScreenshot: defineCommand({
    description:
      'See the preview — a screenshot of the running app, nothing else. Use it whenever a ' +
      'question is about pixels ("is it blank?", "did that render?"): looking costs one ' +
      'call and settles it, where reasoning from source can be confidently wrong.',
    params: { type: 'object', properties: {} },
    handler: async () => {
      const { images } = await readPreview();
      if (images.length === 0) {
        throw new AppCommandError(
          'Preview window returned no screenshot. The iframe may not have painted yet — ' +
            'give it a moment after preview/compile, then retry.',
        );
      }
      return images.map((img) => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      }));
    },
  }),
  previewQuery: defineCommand({
    description: 'Query app protocol state from the preview window',
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
    description: 'Send an app protocol command to the preview window',
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
      'Resize the preview window to width × height pixels. Use this to give a preview more ' +
      'room (e.g. testing a wide layout) instead of relaying the request to the monitor. ' +
      'Unlike re-running preview, this does not remount the iframe, so preview state is kept.',
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
