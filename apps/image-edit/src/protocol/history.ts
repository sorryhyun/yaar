import { defineCommand } from '@bundled/yaar';
import { redoEdit, undoEdit } from '../store';
import { docSummary } from './shared';

export const historyCommands = {
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
};
