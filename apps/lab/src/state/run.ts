import { createSignal } from '@bundled/solid-js';
import { runInKernel, DEFAULT_TIMEOUT_MS } from '../kernel/worker';
import { summarize } from '../lib/summarize';
import { setCellOutput, findCell } from './cells';
import { current, setRunningCell, flashCellFor } from './signals';
import { logAgentRun } from './agent-runs';
import type { CellOutput, RunResult } from '../types';

export interface RunSummary {
  cellId: string;
  ok: boolean;
  summary: string;
  durationMs: number;
  at: number;
  error?: string;
}

/**
 * Who asked for this run. `undefined` is the user clicking ▶; a value means the
 * call arrived over the app protocol, which is what makes it visible: the cell is
 * scrolled to and highlighted, and the run is appended to the agent run log.
 */
export interface RunOrigin {
  via?: 'runCell' | 'runAll';
}

const [lastRun, setLastRun] = createSignal<RunSummary | null>(null);
const [timeoutMs, setTimeoutMs] = createSignal(DEFAULT_TIMEOUT_MS);
export { lastRun, timeoutMs, setTimeoutMs };

function toOutput(r: RunResult): CellOutput {
  return {
    ok: r.ok,
    logs: r.logs || [],
    parts: r.parts || [],
    durationMs: r.durationMs || 0,
    error: r.error,
    at: Date.now(),
  };
}

export async function runCell(id: string, ms?: number, origin?: RunOrigin): Promise<RunSummary> {
  const cell = findCell(id);
  if (!cell) throw new Error('No cell with id ' + id);
  if (origin?.via) flashCellFor(id);
  if (cell.type === 'markdown') {
    const s: RunSummary = {
      cellId: id,
      ok: true,
      summary: 'markdown (nothing to run)',
      durationMs: 0,
      at: Date.now(),
    };
    setLastRun(s);
    if (origin?.via) {
      logAgentRun({
        kind: origin.via,
        cellId: id,
        source: cell.source,
        ok: true,
        durationMs: 0,
        summary: s.summary,
      });
    }
    return s;
  }
  setRunningCell(id);
  try {
    const r = await runInKernel(cell.source, { timeoutMs: ms || timeoutMs(), label: 'cell ' + id });
    const output = toOutput(r);
    setCellOutput(id, output);
    const s: RunSummary = {
      cellId: id,
      ok: r.ok,
      summary: summarize(r),
      durationMs: r.durationMs || 0,
      at: Date.now(),
      error: r.ok ? undefined : (r.error?.name || 'Error') + ': ' + (r.error?.message || ''),
    };
    setLastRun(s);
    if (origin?.via) {
      flashCellFor(id);
      logAgentRun({
        kind: origin.via,
        cellId: id,
        source: cell.source,
        ok: s.ok,
        durationMs: s.durationMs,
        summary: s.summary,
        output,
        error: s.error,
      });
    }
    return s;
  } finally {
    setRunningCell(null);
  }
}

export async function runAll(ms?: number, origin?: RunOrigin): Promise<RunSummary[]> {
  const nb = current();
  if (!nb) return [];
  const out: RunSummary[] = [];
  for (const cell of nb.cells.slice()) {
    if (cell.type !== 'code') continue;
    if (!cell.source.trim()) continue;
    const s = await runCell(cell.id, ms, origin);
    out.push(s);
    if (!s.ok) break;
  }
  return out;
}
