import { createSignal } from '@bundled/solid-js';
import { runInKernel, DEFAULT_TIMEOUT_MS } from './kernel';
import { current, setCellOutput, setRunningCell, findCell } from './store';
import type { CellOutput, OutputPart, RunResult } from './types';

export interface RunSummary {
  cellId: string;
  ok: boolean;
  summary: string;
  durationMs: number;
  at: number;
  error?: string;
}

const [lastRun, setLastRun] = createSignal<RunSummary | null>(null);
const [timeoutMs, setTimeoutMs] = createSignal(DEFAULT_TIMEOUT_MS);
export { lastRun, timeoutMs, setTimeoutMs };

function describePart(p: OutputPart): string {
  switch (p.kind) {
    case 'table':
      return 'table ' + (p.totalRows ?? 0) + ' rows x ' + (p.columns?.length ?? 0) + ' cols [' + (p.columns || []).slice(0, 8).join(', ') + ']';
    case 'chart':
      return 'chart(' + (p.spec?.type || '?') + ', ' + (p.spec?.data.datasets.length || 0) + ' series)';
    case 'image':
      return 'image (' + Math.round((p.src?.length || 0) / 1024) + ' KB)';
    case 'json':
      return 'json (' + (p.json?.length || 0) + ' chars)';
    case 'markdown':
      return 'markdown';
    case 'error':
      return 'error: ' + (p.message || '');
    default: {
      const t = (p.text || '').replace(/\s+/g, ' ').trim();
      return t.length > 160 ? t.slice(0, 160) + '…' : t || 'empty';
    }
  }
}

/** One short line describing what a run produced — what the agent reads. */
export function summarize(r: RunResult): string {
  if (!r.ok) return (r.error?.name || 'Error') + ': ' + (r.error?.message || '');
  const bits: string[] = [];
  const logCount = (r.logs || []).length;
  if (logCount) bits.push(logCount + ' log line' + (logCount === 1 ? '' : 's'));
  for (const p of r.parts || []) bits.push(describePart(p));
  if (r.savedTo) bits.push('saved to ' + r.savedTo);
  return bits.length ? bits.join('; ') : 'no output';
}

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

export async function runCell(id: string, ms?: number): Promise<RunSummary> {
  const cell = findCell(id);
  if (!cell) throw new Error('No cell with id ' + id);
  if (cell.type === 'markdown') {
    const s: RunSummary = { cellId: id, ok: true, summary: 'markdown (nothing to run)', durationMs: 0, at: Date.now() };
    setLastRun(s);
    return s;
  }
  setRunningCell(id);
  try {
    const r = await runInKernel(cell.source, { timeoutMs: ms || timeoutMs(), label: 'cell ' + id });
    setCellOutput(id, toOutput(r));
    const s: RunSummary = {
      cellId: id,
      ok: r.ok,
      summary: summarize(r),
      durationMs: r.durationMs || 0,
      at: Date.now(),
      error: r.ok ? undefined : (r.error?.name || 'Error') + ': ' + (r.error?.message || ''),
    };
    setLastRun(s);
    return s;
  } finally {
    setRunningCell(null);
  }
}

export async function runAll(ms?: number): Promise<RunSummary[]> {
  const nb = current();
  if (!nb) return [];
  const out: RunSummary[] = [];
  for (const cell of nb.cells.slice()) {
    if (cell.type !== 'code') continue;
    if (!cell.source.trim()) continue;
    const s = await runCell(cell.id, ms);
    out.push(s);
    if (!s.ok) break;
  }
  return out;
}
