import { app, defineCommand, errMsg } from '@bundled/yaar';
import { loadDataUrl } from './image-input';
import { loadSample } from './sample';
import { runRecognition } from './recognize';
import { runPageRead, type PageResult } from './pipeline';
import { MODELS, modelById } from './model';
import { DET_MODELS, detModelById } from './detect';
import {
  backend,
  busy,
  detModelId,
  imageSize,
  modelId,
  page,
  results,
  selection,
  setDetModelId,
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

/**
 * Drop `quad` and round the numbers.
 *
 * A page of 40 lines carries 160 corner points, and an agent asking "what does this
 * say" wants none of them — the axis-aligned box plus its angle locates a line well
 * enough to draw a follow-up selection around. The quads stay available in the UI and
 * to the headless hook.
 */
function summarizePage(result: PageResult | null) {
  if (!result) return null;
  return {
    text: result.text,
    lines: result.lines.map((l) => ({
      text: l.text,
      confidence: Math.round(l.confidence * 1000) / 1000,
      readable: l.readable,
      box: {
        x: Math.round(l.box.x),
        y: Math.round(l.box.y),
        width: Math.round(l.box.w),
        height: Math.round(l.box.h),
        angle: Math.round(l.box.angle * 10) / 10,
      },
    })),
    truncated: result.truncated,
    unreadable: result.unreadable,
    modelId: result.modelId,
    detModelId: result.detModelId,
    elapsedMs: Math.round(result.elapsedMs),
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
          detModelId: detModelId(),
          image: imageSize(),
          selection: selection(),
        }),
      },
      page: {
        description: 'The most recent whole-page read: joined text plus one entry per line',
        handler: () => summarizePage(page()),
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
      detectors: {
        description: 'Text-detector sizes that can be selected with setModel',
        handler: () => DET_MODELS.map((m) => ({ id: m.id, label: m.label, bytes: m.bytes })),
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
        description:
          'Choose the recognizer and/or detector size. Larger is more accurate and slower to ' +
          'download. The detector only affects readPage.',
        params: {
          type: 'object',
          properties: {
            modelId: {
              type: 'string',
              enum: ['medium', 'small', 'tiny'],
              description: 'Recognizer — reads the text inside a box.',
            },
            detModelId: {
              type: 'string',
              enum: ['medium', 'small', 'tiny'],
              description: 'Detector — finds the boxes. Defaults to tiny, which is 1.8 MB.',
            },
          },
        },
        handler: (params) => {
          if (params.modelId) setModelId(modelById(params.modelId).id);
          if (params.detModelId) setDetModelId(detModelById(params.detModelId).id);
          return { modelId: modelId(), detModelId: detModelId() };
        },
      }),
      readPage: defineCommand({
        description:
          'Find every line of text in the loaded image and read them all. This is the one to ' +
          'reach for when handed a screenshot or a document — it needs no coordinates. Returns ' +
          'the joined page text plus a per-line breakdown. The first call downloads both a ' +
          'detector and a recognizer, so use a long timeout and read the status state if the ' +
          'transport gives up. A line that comes back with readable:false was found but could ' +
          'not be read, which usually means an unsupported script rather than a bad box.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          try {
            return summarizePage(await runPageRead());
          } catch (e) {
            throw new Error(errMsg(e));
          }
        },
      }),
      recognize: defineCommand({
        description:
          'Read the text in a region of the loaded image. This reads ONE line: pass a box ' +
          'around a single line of text, or use readPage for a whole image. ' +
          'Omit the box to use the current selection, or ' +
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
