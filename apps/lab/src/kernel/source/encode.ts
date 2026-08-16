// KERNEL PART 9/12 — UI-facing encoding: output parts plus show()/md().
// Generous caps here (5000 table rows, 250 KB JSON); the agent budget lives in
// agent-result.ts and the on-disk cap in ../../lib/trim.ts. Do not confuse them.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const ENCODE = String.raw`
/* ----------------------------------------------------------------- encode -- */

function __labCell(v) {
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') {
    if (t === 'string' && v.length > __labLIM.maxCellChars) return v.slice(0, __labLIM.maxCellChars) + '…';
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  return __labClip(__labStringify(v) || String(v), __labLIM.maxCellChars);
}

function __labEncode(v) {
  if (v === undefined) return null;
  if (v && v.__labChart) return { kind: 'chart', spec: v };
  if (v && v.__labGraph) return { kind: 'graph', graph: v };
  if (typeof v === 'string') {
    if (/^data:image\//.test(v)) return { kind: 'image', src: v };
    var tr = v.length > __labLIM.maxStringChars;
    return { kind: 'text', text: tr ? v.slice(0, __labLIM.maxStringChars) + '…' : v, truncated: tr };
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return { kind: 'text', text: String(v) };
  }
  if (v instanceof Error) return { kind: 'error', name: v.name, message: v.message, stack: String(v.stack || '') };
  if (typeof v === 'function') return { kind: 'text', text: '[Function ' + (v.name || 'anonymous') + ']' };
  if (v instanceof Date) return { kind: 'text', text: v.toISOString() };

  var rows = null;
  if (v.__isDf) rows = v.rows;
  else if (v.__isGroup) rows = v.count().rows;
  else if (Array.isArray(v)) rows = v;

  if (rows && rows.length > 0 && __labIsTabular(rows)) {
    var cols = __labColumns(rows);
    var shown = rows.slice(0, __labLIM.maxRows);
    return {
      kind: 'table',
      columns: cols,
      rows: shown.map(function (r) { return cols.map(function (c) { return __labCell(r ? r[c] : undefined); }); }),
      totalRows: rows.length,
      truncated: rows.length > shown.length
    };
  }
  if (rows && rows.length === 0) return { kind: 'table', columns: [], rows: [], totalRows: 0, truncated: false };

  var s = __labStringify(rows || v, 2) || String(v);
  var big = s.length > __labLIM.maxJsonBytes;
  return { kind: 'json', json: big ? s.slice(0, __labLIM.maxJsonBytes) : s, truncated: big };
}

function show(x) {
  var p = __labEncode(x);
  __labS.parts.push(p || { kind: 'text', text: 'undefined' });
  return undefined;
}
function md(text) { __labS.parts.push({ kind: 'markdown', text: String(text) }); return undefined; }
`;
