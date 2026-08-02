// KERNEL PART 11/11 — the message loop: run one cell, catch errors, post results,
// and expose the helpers on self. Must stay last; it closes the worker source.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const RUN_LOOP = String.raw`
/* ---------------------------------------------------------------- run loop -- */

function __labErrorInfo(e) {
  if (e instanceof Error) {
    // Strip the "eval at ... (blob:...)" wrapper V8 adds around Function-constructor
    // code, and shift line numbers back by the two lines the AsyncFunction header
    // occupies so positions roughly match the cell source.
    var stack = String(e.stack || '')
      .replace(/\(eval at [^,]*, /g, '(')
      .replace(/<anonymous>:([0-9]+):([0-9]+)/g, function (m, l, c) {
        return 'cell:' + Math.max(1, Number(l) - 2) + ':' + c;
      });
    var lines = stack.split('\n').filter(function (l) {
      return l.indexOf('__lab') < 0 && l.indexOf('blob:') < 0;
    });
    return { name: e.name || 'Error', message: e.message || String(e), stack: lines.slice(0, 12).join('\n') };
  }
  return { name: 'Error', message: __labFmt(e), stack: '' };
}

async function __labRun(msg) {
  __labS.logs = [];
  __labS.parts = [];
  var t0 = Date.now();
  var out = { type: 'result', runId: msg.runId, ok: true, logs: [], parts: [], durationMs: 0 };
  var value;
  try {
    var body = __labTransform(String(msg.code == null ? '' : msg.code));
    var fn = new __labAF(body);
    value = await fn();
    if (value && typeof value.then === 'function') value = await value;
  } catch (e) {
    out.ok = false;
    out.error = __labErrorInfo(e);
  }

  if (out.ok && msg.saveResultTo) {
    try {
      var payload = (value && value.__isDf) ? value.rows : value;
      await store.write(msg.saveResultTo, payload === undefined ? null : payload);
      out.savedTo = msg.saveResultTo;
    } catch (e2) {
      out.saveError = __labFmt(e2);
    }
  }

  try {
    if (out.ok) {
      var enc = __labEncode(value);
      if (enc) __labS.parts.push(enc);
    }
  } catch (e3) {
    __labS.parts.push({ kind: 'text', text: 'output encode failed: ' + __labFmt(e3) });
  }

  out.logs = __labS.logs;
  out.parts = msg.agent ? [] : __labS.parts;
  out.hasChart = __labS.parts.some(function (p) { return p && p.kind === 'chart'; });
  out.durationMs = Date.now() - t0;

  if (msg.agent) {
    try {
      var ar = out.ok ? __labAgentResult(value, msg.resultLimit) : { result: null, resultType: 'none', truncated: false };
      out.agent = ar;
    } catch (e4) {
      out.agent = { result: null, resultType: 'none', truncated: false, note: 'summary failed: ' + __labFmt(e4) };
    }
  }

  self.postMessage(out);
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg) return;
  if (msg.type === 'bridgeResult') {
    var p = __labS.pending[msg.callId];
    if (!p) return;
    delete __labS.pending[msg.callId];
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || 'bridge call failed'));
    return;
  }
  if (msg.type === 'run') { __labRun(msg); return; }
};

self.onerror = function (e) {
  try { console.error('worker error: ' + (e && e.message ? e.message : String(e))); } catch (x) {}
};

self.df = df; self.csv = csv; self.stats = stats; self.plot = plot;
self.store = store; self.http = http; self.show = show; self.md = md; self.sleep = sleep;

self.postMessage({ type: 'ready' });
`;
