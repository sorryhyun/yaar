import type { CellOutput } from '../types';

/**
 * Snapshot capping — the LAST of the three truncation layers (see AGENTS.md).
 * `__labEncode` caps for the UI and `__labAgentResult` caps for runCode; this one
 * runs just before a notebook is written to disk so a notebook file cannot grow
 * unbounded. It is deliberately the only place these limits live.
 */

const MAX_SNAPSHOT_ROWS = 200;
const MAX_SNAPSHOT_JSON = 20000;
const MAX_SNAPSHOT_IMAGE = 400000;
const MAX_SNAPSHOT_POINTS = 2000;

export function trimOutput(o: CellOutput | undefined): CellOutput | undefined {
  if (!o) return undefined;
  const parts = (o.parts || []).slice(0, 8).map((p) => {
    if (p.kind === 'table' && p.rows) {
      return {
        ...p,
        rows: p.rows.slice(0, MAX_SNAPSHOT_ROWS),
        truncated: p.truncated || p.rows.length > MAX_SNAPSHOT_ROWS,
      };
    }
    if (p.kind === 'json' && p.json && p.json.length > MAX_SNAPSHOT_JSON) {
      return { ...p, json: p.json.slice(0, MAX_SNAPSHOT_JSON), truncated: true };
    }
    if (p.kind === 'text' && p.text && p.text.length > MAX_SNAPSHOT_JSON) {
      return { ...p, text: p.text.slice(0, MAX_SNAPSHOT_JSON), truncated: true };
    }
    if (p.kind === 'image' && p.src && p.src.length > MAX_SNAPSHOT_IMAGE) {
      return { kind: 'text' as const, text: '[image dropped from saved snapshot: ' + p.src.length + ' bytes]' };
    }
    if (p.kind === 'graph' && p.graph) {
      // Expression series are strings and cost nothing; only eagerly sampled point
      // series (a JS function input) can be large.
      const g = p.graph;
      const series = g.series.map((s) =>
        s.points && s.points.length > MAX_SNAPSHOT_POINTS ? { ...s, points: s.points.slice(0, MAX_SNAPSHOT_POINTS) } : s,
      );
      return { ...p, graph: { ...g, series } };
    }
    if (p.kind === 'chart' && p.spec) {
      const spec = p.spec;
      const datasets = spec.data.datasets.map((d) => ({ ...d, data: (d.data || []).slice(0, MAX_SNAPSHOT_POINTS) }));
      return { ...p, spec: { ...spec, data: { ...spec.data, labels: (spec.data.labels || []).slice(0, MAX_SNAPSHOT_POINTS), datasets } } };
    }
    return p;
  });
  return { ...o, parts, logs: (o.logs || []).slice(0, 100) };
}
