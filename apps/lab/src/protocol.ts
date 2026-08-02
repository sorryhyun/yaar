import * as z from '@bundled/zod';
import { defineAppCommand, AppCommandError } from '@bundled/yaar';
import { notebooks, current, findCell } from './store';
import { runInKernel, resetKernel as resetKernelFn } from './kernel';
import { runCell as runCellFn, runAll as runAllFn, lastRun, timeoutMs } from './run';
import type { Cell } from './types';

const MAX_SOURCE_IN_STATE = 4000;
const MAX_AGENT_LOG_CHARS = 4000;

function cellsForState(cells: Cell[]) {
  return cells.map((c) => ({
    id: c.id,
    type: c.type,
    source: c.source.length > MAX_SOURCE_IN_STATE ? c.source.slice(0, MAX_SOURCE_IN_STATE) + '\n…(truncated)' : c.source,
    hasOutput: !!c.output,
  }));
}

function agentLogs(logs: { level: string; text: string }[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of logs || []) {
    const line = l.level === 'log' ? l.text : '[' + l.level + '] ' + l.text;
    if (used + line.length > MAX_AGENT_LOG_CHARS) {
      out.push('… ' + (logs.length - out.length) + ' more log lines omitted');
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out;
}

/* -------------------------------------------------------------- state --- */

export const labState = {
  notebooks: {
    description: 'Saved notebooks: { id, title, updatedAt, cellCount }[]. Newest first.',
    get: () => notebooks(),
  },
  currentNotebook: {
    description:
      'The open notebook: { id, title, cells: [{ id, type, source, hasOutput }] }. Cell OUTPUTS are deliberately excluded (they are large) — read a result with runCode or the summary in lastRun.',
    get: () => {
      const nb = current();
      if (!nb) return null;
      return { id: nb.id, title: nb.title, updatedAt: nb.updatedAt, cells: cellsForState(nb.cells) };
    },
  },
  lastRun: {
    description: 'The most recent cell execution: { cellId, ok, summary, durationMs, at }.',
    get: () => lastRun(),
  },
  kernel: {
    description: 'Kernel settings: { defaultTimeoutMs }.',
    get: () => ({ defaultTimeoutMs: timeoutMs() }),
  },
};

/* ------------------------------------------------------------ commands --- */

export const runCommands = {
  runCode: defineAppCommand({
    description:
      'Run JavaScript in the notebook kernel WITHOUT creating a cell, and get back a COMPRESSED result. Shares the same persistent scope as the notebook cells, so variables defined here are visible to cells and vice versa. Helpers in scope: store (read/write yaar storage), csv, df (mini dataframe), stats, plot, http, show(), sleep(). Top-level await is allowed and the last expression is the result. The result is capped at resultLimit bytes; when it does not fit you get a shape summary plus a sample, and truncated: true. For the full data set saveResultTo a storage path and only the path comes back.',
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
        error: r.ok ? undefined : (r.error?.name || 'Error') + ': ' + (r.error?.message || ''),
        stack: r.ok ? undefined : r.error?.stack || undefined,
      };
    },
  }),

  runCell: defineAppCommand({
    description: 'Run one notebook cell by id and render its output in the UI. Returns a short summary, never the data.',
    params: z.object({ id: z.string(), timeoutMs: z.optional(z.number()) }),
    replay: 'never',
    run: async (p) => {
      if (!findCell(p.id)) throw new AppCommandError('No cell with id ' + p.id);
      return await runCellFn(p.id, p.timeoutMs);
    },
  }),

  runAll: defineAppCommand({
    description: 'Run every code cell top to bottom, stopping at the first failure. Returns one summary per cell.',
    params: z.object({ timeoutMs: z.optional(z.number()) }),
    replay: 'never',
    run: async (p) => {
      const rs = await runAllFn(p.timeoutMs);
      return { ran: rs.length, ok: rs.every((r) => r.ok), cells: rs };
    },
  }),

  resetKernel: defineAppCommand({
    description: 'Restart the worker. Clears every variable defined by earlier cells; notebook sources and saved outputs are untouched.',
    replay: 'never',
    run: () => {
      resetKernelFn();
      return { ok: true };
    },
  }),
};
