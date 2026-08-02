// KERNEL PART 2/11 — value formatting: cycle-safe stringify, clipping, console capture.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const FORMAT = String.raw`
/* ---------------------------------------------------------------- bridge -- */

function __labBridge(method, args) {
  var id = __labS.nextCallId++;
  return new Promise(function (resolve, reject) {
    __labS.pending[id] = { resolve: resolve, reject: reject };
    self.postMessage({ type: 'bridge', callId: id, method: method, args: args });
  });
}

/* ------------------------------------------------------------ formatting -- */

function __labStringify(v, indent) {
  var seen = new WeakSet();
  try {
    return JSON.stringify(v, function (k, val) {
      if (typeof val === 'bigint') return String(val) + 'n';
      if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
      if (typeof val === 'symbol') return String(val);
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        if (val.__isDf) return val.rows;
        if (val.__isGroup) return val.toArray();
        if (val instanceof Map) return { __type: 'Map', entries: Array.from(val.entries()).slice(0, 500) };
        if (val instanceof Set) return { __type: 'Set', values: Array.from(val.values()).slice(0, 500) };
        if (val instanceof Date) return val.toISOString();
        if (ArrayBuffer.isView(val)) return Array.prototype.slice.call(val, 0, 500);
      }
      return val;
    }, indent);
  } catch (e) {
    return '"[unserializable: ' + String(e && e.message) + ']"';
  }
}

function __labFmt(a) {
  if (typeof a === 'string') return a;
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  if (a instanceof Error) return (a.stack || (a.name + ': ' + a.message));
  if (typeof a === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
  if (a && a.__isDf) return 'df(' + a.rows.length + ' rows) ' + __labClip(__labStringify(a.rows.slice(0, 5)) || '', 800);
  if (typeof a === 'object') return __labClip(__labStringify(a) || String(a), 2000);
  return String(a);
}

function __labClip(s, max) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + '…(' + s.length + ' chars)' : s;
}

['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (level) {
  console[level] = function () {
    if (__labS.logs.length >= __labLIM.maxLogs) return;
    var text = Array.prototype.map.call(arguments, __labFmt).join(' ');
    if (text.length > __labLIM.maxLogChars) text = text.slice(0, __labLIM.maxLogChars) + '…';
    __labS.logs.push({ level: (level === 'debug' || level === 'trace') ? 'log' : level, text: text });
  };
});
`;