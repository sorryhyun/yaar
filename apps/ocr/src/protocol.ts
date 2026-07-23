import { app, defineCommand, errMsg } from '@bundled/yaar';
import { loadDataUrl } from './image-input';
import { loadSample } from './sample';
import { runRecognition } from './recognize';
import { MODELS, modelById } from './model';
import {
  backend,
  busy,
  imageSize,
  modelId,
  results,
  selection,
  setModelId,
  status,
  type OcrRecord,
} from './state';

/** Drop `charScores` — 18k floats per call is not something an agent should read. */
function summarize(record: OcrRecord | null) {
  if (!record) return null;
  return {
    text: record.text,
    confidence: record.confidence,
    characters: record.charScores.length,
    rect: record.rect,
    modelId: record.modelId,
    elapsedMs: Math.round(record.elapsedMs),
  };
}

export function registerProtocol(): void {
  if (!app) return;

  app.register({
    appId: 'ocr',
    name: 'OCR',
    state: {
      status: {
        description:
          'Whether a recognition is running, the loaded image size, and the last message',
        handler: () => ({
          busy: busy(),
          message: status(),
          backend: backend(),
          modelId: modelId(),
          image: imageSize(),
          selection: selection(),
        }),
      },
      lastResult: {
        description: 'Text from the most recent recognition, with confidence and timing',
        handler: () => summarize(results()[0] ?? null),
      },
      results: {
        description: 'Recognition history for this window, newest first',
        handler: () => results().map(summarize),
      },
      models: {
        description: 'Recognizer sizes that can be selected with setModel',
        handler: () => MODELS.map((m) => ({ id: m.id, label: m.label, bytes: m.bytes })),
      },
    },
    commands: {
      loadImage: defineCommand({
        description:
          'Load an image to read from, as a data URL (e.g. a screenshot captured elsewhere). ' +
          'Replaces whatever was loaded and clears the selection.',
        params: {
          type: 'object',
          properties: {
            dataUrl: { type: 'string', description: 'A data: URL holding an image.' },
          },
          required: ['dataUrl'],
        },
        handler: async (params) => {
          try {
            return await loadDataUrl(params.dataUrl);
          } catch (e) {
            throw new Error(errMsg(e));
          }
        },
      }),
      loadSample: defineCommand({
        description:
          'Load the built-in multi-script test card. Useful for checking the model runs.',
        params: { type: 'object', properties: {} },
        handler: () => {
          loadSample();
          return imageSize();
        },
      }),
      setModel: defineCommand({
        description: 'Choose the recognizer size. Larger is more accurate and slower to download.',
        params: {
          type: 'object',
          properties: {
            modelId: { type: 'string', enum: ['medium', 'small', 'tiny'] },
          },
          required: ['modelId'],
        },
        handler: (params) => {
          setModelId(modelById(params.modelId).id);
          return { modelId: modelId() };
        },
      }),
      recognize: defineCommand({
        description:
          'Read the text in a region of the loaded image. This is a single-line recognizer: ' +
          'pass a box around ONE line of text. Omit the box to use the current selection, or ' +
          'the whole image when nothing is selected. The first call downloads model weights ' +
          '(4.5–77 MB depending on modelId) and can take a while — use a long timeout and read ' +
          'the status state if the transport gives up.',
        params: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Left edge in image pixels.' },
            y: { type: 'number', description: 'Top edge in image pixels.' },
            width: { type: 'number', description: 'Box width in image pixels.' },
            height: { type: 'number', description: 'Box height in image pixels.' },
          },
        },
        handler: async (params) => {
          const hasRect = [params.x, params.y, params.width, params.height].every(
            (v) => typeof v === 'number',
          );
          try {
            const record = await runRecognition(
              hasRect
                ? { rect: { x: params.x!, y: params.y!, w: params.width!, h: params.height! } }
                : {},
            );
            return summarize(record);
          } catch (e) {
            throw new Error(errMsg(e));
          }
        },
      }),
    },
  });
}
