import * as z from '@bundled/zod';
import { defineAppCommand, AppCommandError } from '@bundled/yaar';
import {
  current, loadIndex, openNotebook as openNb, newNotebook as newNb,
  saveCurrent, addCell as addCellFn, updateCell as updateCellFn, deleteCell as deleteCellFn,
  moveCell as moveCellFn, renameNotebook,
} from './store';
import { saveChart, mediaPath } from './media';
import type { ChartSpec } from './types';

export const notebookCommands = {
  addCell: defineAppCommand({
    description: 'Append or insert a cell. Returns the new cell id. Does not run it — follow with runCell.',
    params: z.object({
      source: z.string(),
      type: z.optional(z.enum(['code', 'markdown'])),
      index: z.optional(z.number()),
    }),
    replay: 'never',
    run: async (p) => {
      const cell = addCellFn(p.source, p.type || 'code', p.index);
      await saveCurrent();
      return { id: cell.id, index: current()?.cells.findIndex((c) => c.id === cell.id) ?? -1 };
    },
  }),

  updateCell: defineAppCommand({
    description: 'Replace a cell\'s source (and optionally its type).',
    params: z.object({ id: z.string(), source: z.string(), type: z.optional(z.enum(['code', 'markdown'])) }),
    run: async (p) => {
      const patch: Record<string, unknown> = { source: p.source };
      if (p.type) patch.type = p.type;
      if (!updateCellFn(p.id, patch)) throw new AppCommandError('No cell with id ' + p.id);
      await saveCurrent();
      return { ok: true, id: p.id };
    },
  }),

  deleteCell: defineAppCommand({
    description: 'Delete a cell by id.',
    params: z.object({ id: z.string() }),
    replay: 'never',
    run: async (p) => {
      if (!deleteCellFn(p.id)) throw new AppCommandError('No cell with id ' + p.id);
      await saveCurrent();
      return { ok: true };
    },
  }),

  moveCell: defineAppCommand({
    description: 'Move a cell up (delta -1) or down (delta 1) in the notebook.',
    params: z.object({ id: z.string(), delta: z.number() }),
    replay: 'never',
    run: async (p) => {
      if (!moveCellFn(p.id, p.delta)) throw new AppCommandError('Cannot move cell ' + p.id + ' by ' + p.delta);
      await saveCurrent();
      return { ok: true };
    },
  }),

  newNotebook: defineAppCommand({
    description: 'Save the open notebook and create a new empty one.',
    params: z.object({ title: z.optional(z.string()) }),
    replay: 'never',
    run: async (p) => {
      await saveCurrent();
      const nb = await newNb(p.title || 'Untitled');
      return { id: nb.id, title: nb.title };
    },
  }),

  openNotebook: defineAppCommand({
    description: 'Save the open notebook and switch to another one by id.',
    params: z.object({ id: z.string() }),
    run: async (p) => {
      await saveCurrent();
      try {
        const nb = await openNb(p.id);
        return { id: nb.id, title: nb.title, cellCount: nb.cells.length };
      } catch (e) {
        throw new AppCommandError('Cannot open notebook ' + p.id + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    },
  }),

  saveNotebook: defineAppCommand({
    description: 'Force-save the open notebook now (it also autosaves after edits).',
    params: z.object({ title: z.optional(z.string()) }),
    run: async (p) => {
      if (p.title) renameNotebook(p.title);
      const ok = await saveCurrent();
      const nb = current();
      return { ok, id: nb?.id, title: nb?.title, cells: nb?.cells.length ?? 0 };
    },
  }),

  listNotebooks: defineAppCommand({
    description: 'Re-read the notebook index from storage and return it.',
    run: async () => ({ notebooks: await loadIndex() }),
  }),

  exportChart: defineAppCommand({
    description:
      'Render a chart produced by a cell to PNG and save it into the shared media tree (media/lab/... by default), so other apps can pick it up. Returns the path only. Omit cellId to use the most recent chart in the notebook.',
    params: z.object({
      cellId: z.optional(z.string()),
      path: z.optional(z.string()),
      width: z.optional(z.number()),
      height: z.optional(z.number()),
      background: z.optional(z.string()),
    }),
    replay: 'never',
    run: async (p) => {
      const nb = current();
      if (!nb) throw new AppCommandError('No notebook is open');
      const cells = p.cellId ? nb.cells.filter((c) => c.id === p.cellId) : nb.cells.slice().reverse();
      if (p.cellId && cells.length === 0) throw new AppCommandError('No cell with id ' + p.cellId);
      let spec: ChartSpec | undefined;
      let fromCell = '';
      for (const c of cells) {
        const part = (c.output?.parts || []).find((x) => x.kind === 'chart' && x.spec);
        if (part) {
          spec = part.spec as ChartSpec;
          fromCell = c.id;
          break;
        }
      }
      if (!spec) {
        throw new AppCommandError(
          p.cellId
            ? 'Cell ' + p.cellId + ' has no chart output. Run it first, and make sure the cell ends in a plot.* call.'
            : 'No cell in this notebook has a chart output yet.',
        );
      }
      const r = await saveChart(spec, mediaPath(p.path, 'chart-' + fromCell + '-' + Date.now()), {
        width: p.width,
        height: p.height,
        background: p.background,
      });
      return { ...r, cellId: fromCell };
    },
  }),
};
