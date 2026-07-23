import { app, defineCommand, errMsg } from '@bundled/yaar';
import { loadDataUrl } from './image-input';
import { runRecognition } from './recognize';
import { runPageRead, type PageResult } from './pipeline';
import { MODELS } from './model';
import { bytesOf, ensureModels, isLoaded, missing, pageModels, requireLoaded } from './warm';
import { captureWindow, listWindows } from './window-source';
import {
  assistIds,
  backend,
  busy,
  detModelId,
  imageSize,
  loading,
  modelId,
  page,
  recognizerIds,
  results,
  selection,
  setDownloadRatio,
  setStatus,
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
      readBy: l.readBy,
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
    assisted: result.assisted,
    modelId: result.modelId,
    modelIds: result.modelIds,
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
        handler: () => {
          const absent = missing(pageModels(recognizerIds(), detModelId()));
          return {
            busy: busy(),
            loading: loading(),
            message: status(),
            backend: backend(),
            modelId: modelId(),
            assist: assistIds(),
            detModelId: detModelId(),
            // What a readPage would have to download. Empty means it can run now.
            modelsMissing: absent.map((m) => `${m.kind} ${m.id}`),
            modelsMissingBytes: bytesOf(absent),
            image: imageSize(),
            selection: selection(),
          };
        },
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
        description:
          'Every recognizer this app ships and which scripts each one covers — what to ' +
          'consult when a line comes back readable:false. `running` marks the ones a read ' +
          'actually uses; the rest are selectable in the window only.',
        handler: () =>
          MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            bytes: m.bytes,
            scripts: m.scripts,
            running: recognizerIds().includes(m.id),
            loaded: isLoaded(`rec:${m.id}`),
          })),
      },
      windows: {
        description:
          'Open windows, any of which readWindow can OCR. Each entry is the windowId to ' +
          'pass, its title, and its renderer — only iframe (app) windows have a screenshot ' +
          'to read.',
        handler: () => listWindows(),
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
      loadModels: defineCommand({
        description:
          'Download the detector and recognizers the current settings need, and nothing ' +
          'else. Reading does NOT download: readPage and recognize fail with a message ' +
          'naming what is missing unless this ran first (or they were passed ' +
          'download:true). Slow on a cold start — 152 MB at the default sizes — and ' +
          'near-instant afterwards, since the weights are cached on disk and reused ' +
          'offline. Use a long timeout, and poll the status state rather than re-issuing ' +
          'this if the transport gives up.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          try {
            const result = await ensureModels(pageModels(recognizerIds(), detModelId()), {
              onProgress: setDownloadRatio,
              onModel: (ref) => setStatus(`Downloading the ${ref.id} ${ref.kind}…`),
            });
            setStatus(`Models ready — ${Math.round(result.bytes / 1_000_000)} MB.`);
            return {
              downloaded: result.loaded.map((m) => `${m.kind} ${m.id}`),
              bytes: result.bytes,
              elapsedMs: Math.round(result.elapsedMs),
            };
          } catch (e) {
            throw new Error(errMsg(e));
          } finally {
            setDownloadRatio(null);
          }
        },
      }),
      readPage: defineCommand({
        description:
          'Find every line of text in the loaded image and read them all. This is the one to ' +
          'reach for when handed a screenshot or a document — it needs no coordinates. Returns ' +
          'the joined page text plus a per-line breakdown. Needs loadModels to have run — ' +
          'this fails rather than downloading 152 MB behind your back. Each line says which ' +
          'model read it in readBy: Korean lines come back from the korean assist, everything ' +
          'else from the primary. A line with readable:false was found but read by nothing, ' +
          'which means a script neither model covers (Cyrillic, Thai, Arabic) rather than a ' +
          'bad box.',
        params: {
          type: 'object',
          properties: {
            download: {
              type: 'boolean',
              description:
                'Fetch any missing weights as part of this call instead of failing. Makes ' +
                'the call take as long as loadModels would. Default false.',
            },
          },
        },
        handler: async (params) => {
          try {
            return summarizePage(await runPageRead({ download: params.download }));
          } catch (e) {
            throw new Error(errMsg(e));
          }
        },
      }),
      readWindow: defineCommand({
        description:
          'Screenshot another open window and read every line of text on it. This is how ' +
          'to OCR something that was never a file: a rendered app, a chart, a page in the ' +
          'Browser. Get the windowId from the `windows` state. Returns what readPage ' +
          'returns, plus which window was captured — and leaves that screenshot as the ' +
          'loaded image, so a follow-up recognize on a line box needs no second capture. ' +
          'Only iframe (app) windows have a screenshot; a markdown/table/component window ' +
          'is already text, so read it directly instead. Needs loadModels to have run.',
        params: {
          type: 'object',
          properties: {
            windowId: {
              type: 'string',
              description: 'The window to capture, from the `windows` state.',
            },
            download: {
              type: 'boolean',
              description:
                'Fetch any missing weights as part of this call instead of failing. Makes ' +
                'the call take as long as loadModels would. Default false.',
            },
          },
          required: ['windowId'],
        },
        handler: async (params) => {
          try {
            // The same refusal readPage makes, made before the capture rather than after
            // it: capturing replaces whatever image was loaded, and a call that is going
            // to be turned away for missing weights should not have thrown that away.
            if (!params.download) requireLoaded(pageModels(recognizerIds(), detModelId()));
            const captured = await captureWindow(params.windowId);
            const result = await runPageRead({ download: params.download });
            return { window: captured, ...summarizePage(result) };
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
          'the whole image when nothing is selected. Needs the recognizers loaded — run ' +
          'loadModels first, or pass download:true. No detector is involved, so this needs ' +
          'less on disk than readPage does.',
        params: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Left edge in image pixels.' },
            y: { type: 'number', description: 'Top edge in image pixels.' },
            width: { type: 'number', description: 'Box width in image pixels.' },
            height: { type: 'number', description: 'Box height in image pixels.' },
            download: {
              type: 'boolean',
              description:
                'Fetch any missing recognizer weights instead of failing. Default false.',
            },
          },
        },
        handler: async (params) => {
          const hasRect = [params.x, params.y, params.width, params.height].every(
            (v) => typeof v === 'number',
          );
          try {
            const record = await runRecognition({
              download: params.download,
              ...(hasRect
                ? { rect: { x: params.x!, y: params.y!, w: params.width!, h: params.height! } }
                : {}),
            });
            return summarize(record);
          } catch (e) {
            throw new Error(errMsg(e));
          }
        },
      }),
    },
  });
}
