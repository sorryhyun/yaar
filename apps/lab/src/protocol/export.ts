import * as z from '@bundled/zod';
import { defineAppCommand, AppCommandError } from '@bundled/yaar';
import { saveChart, mediaPath } from '../lib/media';
import { current } from '../state/signals';
import type { ChartSpec } from '../types';

/** Handing a rendered chart to other apps through the shared media tree. */
export const exportCommands = {
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
