// KERNEL PART 3/12 — the `csv` helper: type casting, parse, stringify.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const CSV = String.raw`
/* -------------------------------------------------------------------- csv -- */

function __labCast(v) {
  if (typeof v !== 'string') return v;
  var t = v.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'NULL' || t === 'NA') return null;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(t)) return Number(t);
  return v;
}

var csv = {
  parse: function (text, opts) {
    opts = opts || {};
    var header = opts.header !== false;
    var delim = opts.delimiter || ',';
    var cast = opts.cast !== false;
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var out = [], row = [], field = '', inQ = false, atStart = true;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else { inQ = false; atStart = false; }
        } else field += c;
        continue;
      }
      if (c === '"' && atStart) { inQ = true; atStart = false; continue; }
      if (c === delim) { row.push(field); field = ''; atStart = true; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); out.push(row); row = []; field = ''; atStart = true; continue;
      }
      field += c; atStart = false;
    }
    if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
    while (out.length && out[out.length - 1].length === 1 && out[out.length - 1][0] === '') out.pop();
    if (!header) return cast ? out.map(function (r) { return r.map(__labCast); }) : out;
    if (!out.length) return [];
    var cols = out[0].map(function (h, ix) { return String(h).trim() || ('col' + ix); });
    var res = [];
    for (var r2 = 1; r2 < out.length; r2++) {
      var o = {};
      for (var ci = 0; ci < cols.length; ci++) {
        var raw = out[r2][ci];
        o[cols[ci]] = raw === undefined ? null : (cast ? __labCast(raw) : raw);
      }
      res.push(o);
    }
    return res;
  },

  stringify: function (rows, opts) {
    opts = opts || {};
    var delim = opts.delimiter || ',';
    var eol = opts.eol || '\n';
    if (rows && rows.__isDf) rows = rows.rows;
    if (!Array.isArray(rows) || rows.length === 0) return '';
    function q(v) {
      if (v === null || v === undefined) return '';
      var s = (typeof v === 'object') ? (__labStringify(v) || '') : String(v);
      if (s.indexOf('"') >= 0 || s.indexOf(delim) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
        return '"' + s.split('"').join('""') + '"';
      }
      return s;
    }
    var lines = [];
    if (Array.isArray(rows[0])) {
      rows.forEach(function (r) { lines.push(r.map(q).join(delim)); });
    } else {
      var cols = opts.columns || __labColumns(rows);
      if (opts.header !== false) lines.push(cols.map(q).join(delim));
      rows.forEach(function (r) { lines.push(cols.map(function (c) { return q(r ? r[c] : ''); }).join(delim)); });
    }
    return lines.join(eol) + eol;
  }
};
`;
