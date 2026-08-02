import type { OutputPart, RunResult } from '../types';

/**
 * Run results collapsed to one short line. This is what the agent reads back from
 * runCell/runAll and what the status bar shows — never the data itself.
 */

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
