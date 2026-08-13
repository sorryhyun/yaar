import * as z from '@bundled/zod';
import { defineAppCommand, AppCommandError } from '@bundled/yaar';
import { saveChart, saveGraph, sharedPath } from '../lib/shared-tree';
import { current } from '../state/signals';
import type { ChartSpec, GraphSpec } from '../types';

/** Handing a rendered chart or graph to other apps through the shared tree. */
export const exportCommands = {
  exportChart: defineAppCommand({
    description:
      'Render a chart or function graph produced by a cell to PNG and save it into the shared tree (shared/lab/... by default), so other apps can pick it up. Returns the path only. Omit cellId to use the most recent chart or graph in the notebook; a graph is rendered at the viewport its spec declares, not at whatever the user has panned to.',
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

      // One command for both output kinds: whichever the cell actually produced.
      let chart: ChartSpec | undefined;
      let graph: GraphSpec | undefined;
      let fromCell = '';
      for (const c of cells) {
        const part = (c.output?.parts || []).find(
          (x) => (x.kind === 'chart' && x.spec) || (x.kind === 'graph' && x.graph),
        );
        if (part) {
          if (part.kind === 'chart') chart = part.spec as ChartSpec;
          else graph = part.graph as GraphSpec;
          fromCell = c.id;
          break;
        }
      }
      if (!chart && !graph) {
        throw new AppCommandError(
          p.cellId
            ? 'Cell ' + p.cellId + ' has no chart or graph output. Run it first, and make sure the cell ends in a plot.* or graph(...) call.'
            : 'No cell in this notebook has a chart or graph output yet.',
        );
      }

      const kind = chart ? 'chart' : 'graph';
      const opts = { width: p.width, height: p.height, background: p.background };
      const target = sharedPath(p.path, kind + '-' + fromCell + '-' + Date.now());
      const r = chart ? await saveChart(chart, target, opts) : await saveGraph(graph!, target, opts);
      return { ...r, cellId: fromCell, kind };
    },
  }),
};