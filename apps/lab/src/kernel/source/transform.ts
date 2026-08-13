// KERNEL PART 11/12 — the source transform: scan, hoist top-level declarations onto
// globalThis, split off a trailing expression as the cell's value. Every stage
// verifies itself and falls back to the untransformed source. Read the AGENTS.md
// section before touching this — especially why a `function` tail is refused.
// Fragment of the worker source; see ../source.ts for the String.raw rules.
export const TRANSFORM = String.raw`
/* -------------------------------------------------------- source transform -- */

var __labKW = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];

function __labScan(src) {
  var n = src.length;
  var depth = new Array(n), code = new Array(n);
  var d = 0, i = 0;

  function fill(a, b, dd, isCode) { for (var k = a; k < b; k++) { depth[k] = dd; code[k] = isCode; } }

  function skipQuoted(start) {
    var q = src.charAt(start), j = start + 1;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return j;
      j++;
      if (ch === q) break;
    }
    return j;
  }
  function skipTemplate(start) {
    var j = start + 1;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === String.fromCharCode(96)) return j + 1;
      if (ch === '$' && src.charAt(j + 1) === '{') {
        var k = j + 2, bd = 1;
        while (k < n && bd > 0) {
          var c2 = src.charAt(k);
          if (c2 === '\\') { k += 2; continue; }
          if (c2 === String.fromCharCode(96)) { k = skipTemplate(k); continue; }
          if (c2 === '"' || c2 === "'") { k = skipQuoted(k); continue; }
          if (c2 === '{') bd++;
          else if (c2 === '}') bd--;
          k++;
        }
        j = k; continue;
      }
      j++;
    }
    return n;
  }
  function regexAllowed(at) {
    var j = at - 1;
    while (j >= 0 && /\s/.test(src.charAt(j))) j--;
    if (j < 0) return true;
    var ch = src.charAt(j);
    if (ch === ')' || ch === ']') return false;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      var e = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$]/.test(src.charAt(j))) j--;
      var word = src.slice(j + 1, e);
      return __labKW.indexOf(word) >= 0;
    }
    return true;
  }
  function skipRegex(start) {
    var j = start + 1, inClass = false;
    while (j < n) {
      var ch = src.charAt(j);
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return j;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { j++; break; }
      j++;
    }
    while (j < n && /[a-z]/i.test(src.charAt(j))) j++;
    return j;
  }

  while (i < n) {
    var c = src.charAt(i), c2 = src.charAt(i + 1), j;
    if (c === '/' && c2 === '/') { j = src.indexOf('\n', i); if (j < 0) j = n; fill(i, j, d, 0); i = j; continue; }
    if (c === '/' && c2 === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; fill(i, j, d, 0); i = j; continue; }
    if (c === String.fromCharCode(96)) { j = skipTemplate(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '"' || c === "'") { j = skipQuoted(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '/' && regexAllowed(i)) { j = skipRegex(i); fill(i, j, d, 0); i = j; continue; }
    if (c === '{' || c === '(' || c === '[') { depth[i] = d; code[i] = 1; d++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { d--; if (d < 0) d = 0; depth[i] = d; code[i] = 1; i++; continue; }
    depth[i] = d; code[i] = 1; i++;
  }
  return { depth: depth, code: code };
}

function __labCompiles(body) {
  try { new __labAF(body); return true; } catch (e) { return false; }
}

function __labStmtStart(src, sc, at) {
  var j = at - 1;
  var sawNewline = false;
  while (j >= 0) {
    var ch = src.charAt(j);
    if (!sc.code[j]) {
      if (ch === '\n') sawNewline = true;
      j--; continue;
    }
    if (/\s/.test(ch)) { if (ch === '\n') sawNewline = true; j--; continue; }
    break;
  }
  if (j < 0) return true;
  var p = src.charAt(j);
  if (p === ';' || p === '}' || p === '{') return true;
  return sawNewline;
}

function __labHoist(src) {
  var sc = __labScan(src);
  var edits = [];
  var names = [];
  var re = /(^|[^A-Za-z0-9_$.])(const|let|var|function|class|async)(?![A-Za-z0-9_$])/g;
  var m;
  var declStarts = [];
  while ((m = re.exec(src)) !== null) {
    var at = m.index + m[1].length;
    if (!sc.code[at] || sc.depth[at] !== 0) continue;
    if (!__labStmtStart(src, sc, at)) continue;
    declStarts.push(at);
  }
  function nextDeclAfter(pos) {
    for (var i = 0; i < declStarts.length; i++) if (declStarts[i] > pos) return declStarts[i];
    return src.length;
  }

  for (var di = 0; di < declStarts.length; di++) {
    var at = declStarts[di];
    var rest = src.slice(at);
    var kwm = /^(const|let|var|function|class|async)/.exec(rest);
    if (!kwm) continue;
    var kw = kwm[1];
    var after = at + kw.length;

    if (kw === 'async') {
      var am = /^\s*function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(after));
      if (am) names.push(am[1]);
      continue;
    }
    if (kw === 'function' || kw === 'class') {
      var fm = /^\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(after));
      if (fm) names.push(fm[1]);
      continue;
    }

    var bm = /^(\s*)([A-Za-z_$\[{])/.exec(src.slice(after));
    if (!bm) continue;

    var limit = Math.min(nextDeclAfter(at), src.length);
    var end = limit, sawEq = false;
    for (var p = after; p < limit; p++) {
      if (!sc.code[p] || sc.depth[p] !== 0) continue;
      var ch = src.charAt(p);
      if (ch === ';') { end = p; break; }
      if (ch === '=' && src.charAt(p + 1) !== '=' && src.charAt(p + 1) !== '>' &&
          '=!<>+-*/%&|^'.indexOf(src.charAt(p - 1)) < 0) { sawEq = true; }
      if (ch === '\n' && sawEq) { end = p; break; }
    }

    if (bm[2] === '[' || bm[2] === '{') {
      edits.push({ pos: at, len: kw.length, text: ';(' });
      edits.push({ pos: end, len: 0, text: ')' });
    } else if (sawEq) {
      edits.push({ pos: at, len: kw.length, text: '' });
    } else {
      edits.push({ pos: at, len: kw.length, text: 'globalThis.' });
    }
  }

  edits.sort(function (a, b) { return b.pos - a.pos || b.len - a.len; });
  var out = src;
  for (var ei = 0; ei < edits.length; ei++) {
    var e = edits[ei];
    out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
  }

  var assigns = names.length
    ? '\n' + names.map(function (nm) { return 'try { globalThis[' + JSON.stringify(nm) + '] = ' + nm + '; } catch (__e) {}'; }).join('\n') + '\n'
    : '';

  if (!__labCompiles(out + assigns)) return { body: src, assigns: '' };
  return { body: out, assigns: assigns };
}

function __labSplitTail(src) {
  var sc = __labScan(src);
  var cands = [0];
  for (var i = 0; i < src.length; i++) {
    if (!sc.code[i] || sc.depth[i] !== 0) continue;
    var ch = src.charAt(i);
    if (ch === ';' || ch === '\n' || ch === '}') cands.push(i + 1);
  }
  var start = Math.max(0, cands.length - 120);
  for (var k = cands.length - 1; k >= start; k--) {
    var p = cands[k];
    var head = src.slice(0, p);
    var tail = src.slice(p).replace(/\s+$/, '').replace(/;+$/, '');
    if (!tail.trim()) continue;
    // A trailing function/class DECLARATION must not become the tail expression.
    // It compiles fine as one -- but as a named function *expression* the name binds
    // only inside itself, so __labHoist's "globalThis.f = f" (emitted ahead of the
    // return) throws ReferenceError into its own catch and the binding is silently
    // lost. A cell holding just a helper definition is the common case, so this
    // costs a REPL value nobody wanted and buys declarations that persist.
    if (/^\s*(async\s+function\b|function\b|class\b)/.test(tail)) continue;
    if (!__labCompiles('return (' + tail + '\n);')) continue;
    if (p > 0 && !__labCompiles(head)) continue;
    return { head: head, tail: tail };
  }
  return { head: src, tail: null };
}

function __labTransform(code) {
  var h = __labHoist(code);
  var sp = __labSplitTail(h.body);
  var body = sp.head + h.assigns;
  if (sp.tail !== null) body += '\nreturn (' + sp.tail + '\n);';
  if (!__labCompiles(body)) {
    body = h.body + h.assigns;
    if (!__labCompiles(body)) body = code;
  }
  return body;
}
`;