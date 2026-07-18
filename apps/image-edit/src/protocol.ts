import { app, defineCommand } from '@bundled/yaar';
import { outputSize, sourceRect, type Doc } from './core/doc';
import type { ExportFormat } from './core/render';
import {
  canRedo,
  canUndo,
  deleteStorageFile,
  dispatch,
  doc,
  downloadExport,
  exportAsDataUrl,
  openImage,
  openStoragePath,
  redoEdit,
  refreshStorageFiles,
  saveToStorage,
  status,
  storageFiles,
  undoEdit,
} from './store';

const FORMATS = ['png', 'jpeg', 'webp'] as const;

function requireDoc(): Doc {
  const d = doc();
  if (!d) throw new Error('No image is open. Call `open` first.');
  return d;
}

/** What the agent sees after every command — enough to plan the next one. */
function docSummary(d: Doc) {
  return {
    name: d.base.name,
    sourceSize: { w: d.base.w, h: d.base.h },
    outputSize: outputSize(d),
    crop: d.crop,
    rotate: d.rotate,
    flipX: d.flipX,
    flipY: d.flipY,
    resize: d.resize,
    filters: d.filters,
  };
}

export function registerProtocol(): void {
  if (!app || typeof app.register !== 'function') return;

  app.register({
    appId: 'image-edit',
    name: 'Image Edit',
    state: {
      document: {
        description:
          'The full edit document: source size, output size, crop, rotation, flips, resize, and filter values.',
        handler: () => {
          const d = doc();
          return d ? docSummary(d) : null;
        },
      },
      canUndo: {
        description: 'Whether undo and redo are currently available.',
        handler: () => ({ undo: canUndo(), redo: canRedo() }),
      },
      status: {
        description: 'Current status bar text.',
        handler: () => status(),
      },
      library: {
        description:
          'Images saved in this app’s storage, as { path, name, url }. Open one with the `open` command using its path.',
        handler: async () => {
          await refreshStorageFiles();
          return storageFiles();
        },
      },
    },
    commands: {
      open: defineCommand({
        description:
          'Open an image for editing from a storage path, URL, or data URL. Resets edit history.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            url: { type: 'string' },
            dataUrl: { type: 'string' },
            name: { type: 'string' },
          },
        },
        handler: async (p) => {
          if (p.path) {
            await openStoragePath(p.path);
          } else {
            const src = p.url || p.dataUrl;
            if (!src) throw new Error('Provide one of: path, url, dataUrl.');
            await openImage(src, p.name || 'image');
          }
          return docSummary(requireDoc());
        },
      }),

      crop: defineCommand({
        description:
          'Crop to a rectangle in SOURCE image pixels (independent of current rotation). Clamped to the image bounds.',
        params: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['x', 'y', 'w', 'h'],
        },
        handler: (p) => docSummary(dispatch({ type: 'crop', rect: p })),
      }),

      cropAspect: defineCommand({
        description:
          'Crop to an aspect ratio, centred, taking the largest area that fits. Use for "make this square" (1:1) or "make this 16:9".',
        params: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Aspect width, e.g. 16' },
            height: { type: 'number', description: 'Aspect height, e.g. 9' },
          },
          required: ['width', 'height'],
        },
        handler: (p) => {
          const d = requireDoc();
          if (p.width <= 0 || p.height <= 0) throw new Error('Aspect values must be positive.');
          // Fit inside the CURRENT source rect, so successive aspect crops
          // narrow the region instead of jumping back to the full image.
          const src = sourceRect(d);
          const target = p.width / p.height;
          let w = src.w;
          let h = Math.round(w / target);
          if (h > src.h) {
            h = src.h;
            w = Math.round(h * target);
          }
          return docSummary(
            dispatch({
              type: 'crop',
              rect: {
                x: src.x + Math.round((src.w - w) / 2),
                y: src.y + Math.round((src.h - h) / 2),
                w,
                h,
              },
            }),
          );
        },
      }),

      uncrop: defineCommand({
        description: 'Remove the crop and restore the full image area.',
        params: { type: 'object', properties: {} },
        handler: () => docSummary(dispatch({ type: 'uncrop' })),
      }),

      rotate: defineCommand({
        description:
          'Rotate by a relative amount in degrees, snapped to the nearest 90. Negative rotates counter-clockwise.',
        params: {
          type: 'object',
          properties: { degrees: { type: 'number' } },
          required: ['degrees'],
        },
        handler: (p) => docSummary(dispatch({ type: 'rotate', degrees: p.degrees })),
      }),

      flip: defineCommand({
        description: 'Mirror the image along an axis.',
        params: {
          type: 'object',
          properties: { axis: { type: 'string', enum: ['horizontal', 'vertical'] } },
          required: ['axis'],
        },
        handler: (p) => docSummary(dispatch({ type: 'flip', axis: p.axis })),
      }),

      resize: defineCommand({
        description:
          'Set output dimensions. Supply only width or only height to scale proportionally (lockAspect defaults to true).',
        params: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            lockAspect: { type: 'boolean' },
          },
        },
        handler: (p) => {
          if (p.width == null && p.height == null)
            throw new Error('Provide width, height, or both.');
          return docSummary(
            dispatch({
              type: 'resize',
              width: p.width,
              height: p.height,
              lockAspect: p.lockAspect,
            }),
          );
        },
      }),

      scale: defineCommand({
        description: 'Resize by a factor of the current output size. 0.5 halves it, 2 doubles it.',
        params: {
          type: 'object',
          properties: { factor: { type: 'number' } },
          required: ['factor'],
        },
        handler: (p) => {
          const d = requireDoc();
          if (!(p.factor > 0)) throw new Error('Factor must be greater than 0.');
          const out = outputSize(d);
          return docSummary(
            dispatch({
              type: 'resize',
              width: Math.max(1, Math.round(out.w * p.factor)),
              height: Math.max(1, Math.round(out.h * p.factor)),
              lockAspect: false,
            }),
          );
        },
      }),

      filter: defineCommand({
        description:
          'Set filter values. brightness/contrast/saturation are percentages where 100 is unchanged; blur is pixels at full resolution. Only the supplied keys change.',
        params: {
          type: 'object',
          properties: {
            brightness: { type: 'number' },
            contrast: { type: 'number' },
            saturation: { type: 'number' },
            blur: { type: 'number' },
          },
        },
        handler: (p) => {
          const values = Object.fromEntries(
            Object.entries(p).filter(([, v]) => typeof v === 'number'),
          );
          if (!Object.keys(values).length) throw new Error('Provide at least one filter value.');
          return docSummary(dispatch({ type: 'filter', values }));
        },
      }),

      resetFilters: defineCommand({
        description: 'Return all filters to their neutral values.',
        params: { type: 'object', properties: {} },
        handler: () => docSummary(dispatch({ type: 'resetFilters' })),
      }),

      reset: defineCommand({
        description: 'Discard every edit and return to the original image. Undoable.',
        params: { type: 'object', properties: {} },
        handler: () => docSummary(dispatch({ type: 'reset' })),
      }),

      undo: defineCommand({
        description: 'Undo the last edit.',
        params: { type: 'object', properties: {} },
        handler: () => {
          const d = undoEdit();
          return d ? docSummary(d) : { ok: false, reason: 'Nothing to undo.' };
        },
      }),

      redo: defineCommand({
        description: 'Redo the last undone edit.',
        params: { type: 'object', properties: {} },
        handler: () => {
          const d = redoEdit();
          return d ? docSummary(d) : { ok: false, reason: 'Nothing to redo.' };
        },
      }),

      export: defineCommand({
        description:
          'Render the result at full resolution and download it. Returns the file name and output size.',
        params: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: FORMATS },
            quality: { type: 'number', description: '0-1, for jpeg and webp' },
          },
        },
        handler: async (p) => {
          const format = (p.format ?? 'png') as ExportFormat;
          const name = await downloadExport(format, p.quality ?? 0.92);
          return { name, ...outputSize(requireDoc()) };
        },
      }),

      saveToStorage: defineCommand({
        description:
          'Render at full resolution and save into this app’s storage, where it persists and can be reopened. Prefer this over `export` when the result should stay in YAAR rather than go to the user’s downloads.',
        params: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: FORMATS },
            name: {
              type: 'string',
              description: 'File name without extension. Defaults to "<original>-edited".',
            },
            quality: { type: 'number', description: '0-1, for jpeg and webp' },
          },
        },
        handler: async (p) => {
          const file = await saveToStorage(
            (p.format ?? 'png') as ExportFormat,
            p.name,
            p.quality ?? 0.92,
          );
          return { ...file, ...outputSize(requireDoc()) };
        },
      }),

      deleteStorageFile: defineCommand({
        description: 'Delete a saved image from this app’s storage by path.',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p) => {
          await deleteStorageFile(p.path);
          return { deleted: p.path, remaining: storageFiles().length };
        },
      }),

      exportDataUrl: defineCommand({
        description:
          'Render at full resolution and return a base64 data URL instead of downloading. Use when the result must be passed to another app; the string can be large.',
        params: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: FORMATS },
            quality: { type: 'number' },
          },
        },
        handler: (p) => ({
          dataUrl: exportAsDataUrl((p.format ?? 'png') as ExportFormat, p.quality ?? 0.92),
        }),
      }),
    },
  });
}
