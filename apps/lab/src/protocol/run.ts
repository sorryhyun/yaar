import * as z from '@bundled/zod';
import { defineAppCommand, AppCommandError } from '@bundled/yaar';
import { findCell } from '../state/cells';
import { runInKernel, resetKernel as resetKernelFn } from '../kernel/worker';
import { runCell as runCellFn, runAll as runAllFn, timeoutMs } from '../state/run';
import { logAgentRun } from '../state/agent-runs';
import { summarize } from '../lib/summarize';
import { agentLogs } from './shape';

/** Execution commands: everything that puts code through the kernel. */
export const runCommands = {
  runCode: defineAppCommand({
    description:
      "Run JavaScript in the notebook kernel WITHOUT creating a cell, and get back a COMPRESSED result. Shares the same persistent scope as the notebook cells, so variables defined here are visible to cells and vice versa. Helpers in scope: store (read/write storage), csv, df (mini dataframe), stats, plot, http, show(), sleep(). store paths are two-tier: a bare path like 'notebooks/x.json' is this app's private storage, and shared storage takes an explicit URI, 'yaar://storage/shared/lab/x.png'. Top-level await is allowed and the last expression is the result. The result is capped at resultLimit bytes; when it does not fit you get a shape summary plus a sample, and truncated: true. For the full data set saveResultTo a storage path and only the path comes back. The run is also logged to the Agent runs view in the window, which the window switches to — source, logs, rendered result and duration, so the user sees what you ran. The return value here is unaffected.",
    params: z.object({
      code: z.string(),
      timeoutMs: z.optional(z.number()),
      resultLimit: z.optional(z.number()),
      saveResultTo: z.optional(z.string()),
    }),
    replay: 'never',
    run: async (p) => {
      const r = await runInKernel(p.code, {
        agent: true,
        timeoutMs: p.timeoutMs || timeoutMs(),
        resultLimit: p.resultLimit,
        saveResultTo: p.saveResultTo,
        label: 'agent runCode',
      });
      const a = r.agent || { result: null, resultType: 'none', truncated: false };
      const error = r.ok ? undefined : (r.error?.name || 'Error') + ': ' + (r.error?.message || '');
      // UI-side only: the panel entry never changes what the agent gets back.
      logAgentRun({
        kind: 'runCode',
        source: p.code,
        ok: r.ok,
        durationMs: r.durationMs || 0,
        summary: summarize(r),
        output: {
          ok: r.ok,
          logs: r.logs || [],
          parts: r.parts || [],
          durationMs: r.durationMs || 0,
          error: r.error,
          at: Date.now(),
        },
        savedTo: r.savedTo,
        saveError: r.saveError,
        error,
        truncated: a.truncated,
        // A runCode has no cell to render into, so bring the log to the front.
        focus: true,
      });
      return {
        ok: r.ok,
        logs: agentLogs(r.logs || []),
        result: a.result,
        resultType: a.resultType,
        truncated: a.truncated,
        shape: a.shape,
        durationMs: r.durationMs,
        savedTo: r.savedTo,
        saveError: r.saveError,
        error,
        stack: r.ok ? undefined : r.error?.stack || undefined,
      };
    },
  }),

  runCell: defineAppCommand({
    description:
      'Run one notebook cell by id and render its output in the UI. The cell is scrolled into view and briefly highlighted so the user sees which one you touched. Returns a short summary, never the data.',
    params: z.object({ id: z.string(), timeoutMs: z.optional(z.number()) }),
    replay: 'never',
    run: async (p) => {
      if (!findCell(p.id)) throw new AppCommandError('No cell with id ' + p.id);
      return await runCellFn(p.id, p.timeoutMs, { via: 'runCell' });
    },
  }),

  runAll: defineAppCommand({
    description:
      'Run every code cell top to bottom, stopping at the first failure. Each cell is scrolled into view and highlighted as it runs. Returns one summary per cell.',
    params: z.object({ timeoutMs: z.optional(z.number()) }),
    replay: 'never',
    run: async (p) => {
      const rs = await runAllFn(p.timeoutMs, { via: 'runAll' });
      return { ran: rs.length, ok: rs.every((r) => r.ok), cells: rs };
    },
  }),

  resetKernel: defineAppCommand({
    description:
      'Restart the worker. Clears every variable defined by earlier cells; notebook sources and saved outputs are untouched.',
    replay: 'never',
    run: () => {
      resetKernelFn();
      return { ok: true };
    },
  }),
};
