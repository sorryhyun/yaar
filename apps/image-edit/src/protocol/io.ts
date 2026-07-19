import { defineCommand } from '@bundled/yaar';
import { outputSize } from '../core/doc';
import type { ExportFormat } from '../core/render';
import {
  deleteStorageFile,
  downloadExport,
  exportAsDataUrl,
  libraryOpen,
  publishToMedia,
  refreshStorageFiles,
  saveToStorage,
  setLibraryOpen,
  storageFiles,
} from '../store';
import { FORMATS, requireDoc } from './shared';

export const ioCommands = {
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

  setLibraryOpen: defineCommand({
    description:
      'Show or hide the library modal. Opening also refreshes the listing. Exposed so the UI can be driven and screenshotted without a real click.',
    params: {
      type: 'object',
      properties: {
        open: { type: 'boolean', description: 'Omit to toggle.' },
      },
    },
    handler: async (p) => {
      const next = p.open == null ? !libraryOpen() : !!p.open;
      setLibraryOpen(next);
      if (next) await refreshStorageFiles();
      return { open: libraryOpen(), files: storageFiles().length };
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

  publish: defineCommand({
    description:
      'Render at full resolution and publish to the shared media tree ' +
      '(yaar://storage/media/image-edit/), where other apps can reach it — e.g. so devtools ' +
      'can import it as an asset for an app it is building. This is the right way to hand ' +
      'an image to another app: the bytes are written once and copied server-side, never ' +
      'passed around as a string. Returns the shared URI.',
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
      const published = await publishToMedia(
        (p.format ?? 'png') as ExportFormat,
        p.name,
        p.quality ?? 0.92,
      );
      return { ...published, ...outputSize(requireDoc()) };
    },
  }),

  exportDataUrl: defineCommand({
    description:
      'DEPRECATED — prefer `publish`, which hands the image to another app without the ' +
      'bytes passing through the caller. Renders at full resolution and returns a base64 ' +
      'data URL; the string can be several hundred KB.',
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
};
