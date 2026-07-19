import { app, defineCommand } from '@bundled/yaar';
import { drawCommands } from './protocol/draw';
import { filterCommands } from './protocol/filters';
import { historyCommands } from './protocol/history';
import { ioCommands } from './protocol/io';
import { selectionCommands } from './protocol/selection';
import { docSummary, requireDoc, selectionSummary } from './protocol/shared';
import { transformCommands } from './protocol/transform';
import {
  canRedo,
  canUndo,
  doc,
  openImage,
  openStoragePath,
  libraryOpen,
  refreshStorageFiles,
  status,
  storageFiles,
} from './store';

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
      selection: {
        description:
          'The active selection as { pixels, percent, bounds } in source coordinates, or null. Use after `magicWand` to check whether the tolerance caught the right region before committing to `removeSelection`.',
        handler: () => {
          const d = doc();
          return d ? selectionSummary(d) : null;
        },
      },
      libraryOpen: {
        description:
          'Whether the library modal is currently showing. Pair with the `setLibraryOpen` command to open the modal and then verify it visually.',
        handler: () => libraryOpen(),
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

      ...transformCommands,

      ...filterCommands,

      ...historyCommands,

      ...selectionCommands,

      ...drawCommands,

      ...ioCommands,
    },
  });
}
