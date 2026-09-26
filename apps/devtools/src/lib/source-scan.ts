export {};
import { globToRegExp } from './paths';

// Lexical scans over app source: comments, string literals and code told apart by a
// hand-written tokenizer, with no parser and no type information. Everything that
// reads "is this only a comment", "which classes does this app name" or "does this
// comment point at a file that exists" goes through here, so the three agree on
// what counts as a comment.
//
// A regex literal is recognised by the character before it, the way a JS lexer
// decides it. A misread there can only make two versions look *different* (the scan
// swallows the same bytes from both), so `classifyChange` fails towards running a
// build, never towards skipping one.

export interface ScannedSource {
  /**
   * The source with every comment removed and whitespace outside literals collapsed
   * to one space, or one newline where the run held one (ASI reads newlines).
   * Literals are kept byte for byte.
   */
  code: string;
  comments: { text: string; line: number }[];
  /** The text of every string literal and template chunk, in source order. */
  strings: string[];
}

const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** Scan TypeScript or JavaScript. JSX text is not understood — see `classifyChange`. */
export function scanJs(src: string): ScannedSource {
  const comments: ScannedSource['comments'] = [];
  const strings: string[] = [];
  let code = '';
  let pendingWs = '';
  let line = 1;
  let prevSig = '';
  let word = '';
  // Brace depth at which each open `${` hands control back to its template.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;

  const emit = (text: string) => {
    if (pendingWs && code) code += pendingWs;
    pendingWs = '';
    code += text;
  };
  const space = (newline: boolean) => {
    if (newline) pendingWs = '\n';
    else if (!pendingWs) pendingWs = ' ';
  };

  const templateChunk = () => {
    const start = i;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`' || (ch === '$' && src[i + 1] === '{')) {
        const text = src.slice(start, i);
        strings.push(text);
        line += countNewlines(text);
        if (ch === '`') {
          emit(text + '`');
          i += 1;
          prevSig = '`';
        } else {
          emit(text + '${');
          i += 2;
          templates.push(depth);
          depth += 1;
          prevSig = '{';
        }
        word = '';
        return;
      }
      i += 1;
    }
    const rest = src.slice(start);
    strings.push(rest);
    emit(rest);
  };

  const regexAllowed = () =>
    word ? REGEX_KEYWORDS.has(word) : prevSig === '' || REGEX_PRECEDERS.includes(prevSig);

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n') {
      line += 1;
      space(true);
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      space(false);
      i += 1;
      continue;
    }
    if (c === '/' && d === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      comments.push({ text: src.slice(i + 2, end), line });
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2);
      const text = src.slice(i + 2, close < 0 ? n : close);
      comments.push({ text, line });
      const lines = countNewlines(text);
      line += lines;
      space(lines > 0);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i = Math.min(i + 1, n);
      const literal = src.slice(start, i);
      strings.push(literal.slice(1, -1));
      line += countNewlines(literal);
      emit(literal);
      prevSig = c;
      word = '';
      continue;
    }
    if (c === '`') {
      emit('`');
      i += 1;
      templateChunk();
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j += 1;
      }
      if (src[j] === '/') {
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        emit(src.slice(i, j));
        prevSig = '/';
        word = '';
        i = j;
        continue;
      }
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (templates.length && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth -= 1;
        emit('}');
        i += 1;
        templateChunk();
        continue;
      }
      depth -= 1;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      word = src.slice(i, j);
      emit(word);
      prevSig = word[word.length - 1];
      i = j;
      continue;
    }
    emit(c);
    prevSig = c;
    word = '';
    i += 1;
  }
  return { code, comments, strings };
}

/** Scan CSS: block comments and quoted strings; everything else is code. */
export function scanCss(src: string): ScannedSource {
  const comments: ScannedSource['comments'] = [];
  const strings: string[] = [];
  let code = '';
  let pendingWs = '';
  let line = 1;
  let i = 0;
  const n = src.length;
  const emit = (text: string) => {
    if (pendingWs && code) code += pendingWs;
    pendingWs = '';
    code += text;
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const text = src.slice(i + 2, close < 0 ? n : close);
      comments.push({ text, line });
      line += countNewlines(text);
      if (!pendingWs) pendingWs = ' ';
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === '\n') line += 1;
      if (!pendingWs) pendingWs = ' ';
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i = Math.min(i + 1, n);
      const literal = src.slice(start, i);
      strings.push(literal.slice(1, -1));
      emit(literal);
      continue;
    }
    emit(c);
    i += 1;
  }
  return { code, comments, strings };
}

const JS_EXT = new Set(['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']);
const DOC_EXT = new Set(['md', 'markdown', 'txt']);

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
}

/**
 * What an edit to one file can affect.
 *
 * `docs`: a Markdown or text file outside `src/` — nothing the bundler or the type
 * checker reads. Under `src/` it may be imported as an asset, so it counts as code.
 * `comments`: a TS/JS/CSS file whose code is unchanged once comments and layout are
 * set aside. `code`: anything else, including every `.tsx`/`.jsx` (JSX text can hold a
 * `//` that is not a comment) and every file type this does not know.
 */
export type ChangeKind = 'docs' | 'comments' | 'code';

export function classifyChange(path: string, before: string, after: string): ChangeKind {
  const ext = extOf(path);
  if (DOC_EXT.has(ext) && !path.startsWith('src/')) return 'docs';
  if (before === after) return 'comments';
  if (JS_EXT.has(ext)) return scanJs(before).code === scanJs(after).code ? 'comments' : 'code';
  if (ext === 'css') return scanCss(before).code === scanCss(after).code ? 'comments' : 'code';
  return 'code';
}

// ── File references in comments ─────────────────────────────────────────────────

export interface StaleFileRef {
  file: string;
  line: number;
  ref: string;
}

const FILE_REF = /(?<![\w@.\-/*])(?:\.{1,2}\/)*[\w@-][\w@.\-/]*\.(?:ts|tsx|js|jsx|mjs|css)\b/g;

/**
 * Source-file names written in comments and Markdown that match no file in the project.
 *
 * Scans comments of TS/JS/CSS files and the whole text of Markdown files; string
 * literals are code, and a path in one is the program's business. A reference
 * resolves when some project path equals it or ends with `/` + it, after leading `./`
 * and `../` are dropped, so `lib/edits.ts` and `edits.ts` both find `src/lib/edits.ts`.
 * A path whose first directory is not a directory name anywhere in the project
 * (`packages/server/…`) points outside it and is not reported.
 */
export function findStaleFileRefs(
  sources: { path: string; text: string }[],
  projectPaths: string[],
): StaleFileRef[] {
  const dirNames = new Set<string>();
  for (const p of projectPaths) {
    const segs = p.split('/');
    for (const s of segs.slice(0, -1)) dirNames.add(s);
  }
  const resolves = (ref: string) => {
    const bare = ref.replace(/^(?:\.{1,2}\/)+/, '');
    if (projectPaths.some((p) => p === bare || p.endsWith('/' + bare))) return true;
    const first = bare.includes('/') ? bare.split('/')[0] : null;
    return first !== null && !dirNames.has(first);
  };
  const out: StaleFileRef[] = [];
  const check = (file: string, text: string, line: number) => {
    const clean = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '');
    for (const m of clean.matchAll(FILE_REF)) {
      if (!resolves(m[0])) out.push({ file, line, ref: m[0] });
    }
  };
  for (const { path, text } of sources) {
    const ext = extOf(path);
    if (DOC_EXT.has(ext)) {
      text.split('\n').forEach((l, idx) => check(path, l, idx + 1));
      continue;
    }
    const scanned =
      JS_EXT.has(ext) || ext === 'tsx' || ext === 'jsx'
        ? scanJs(text)
        : ext === 'css'
          ? scanCss(text)
          : null;
    if (!scanned) continue;
    for (const c of scanned.comments) {
      c.text.split('\n').forEach((l, idx) => check(path, l, c.line + idx));
    }
  }
  return out;
}

// ── CSS classes ─────────────────────────────────────────────────────────────────

const CLASS_NAME = /^-?[_a-zA-Z][\w-]*$/;

/** Class names in the selectors of one stylesheet (declaration bodies are skipped). */
export function cssSelectorClasses(css: string): string[] {
  const code = scanCss(css).code;
  const out = new Set<string>();
  let segment = '';
  for (const ch of code) {
    if (ch === '{') {
      const prelude = segment.slice(segment.lastIndexOf(';') + 1).trim();
      if (!prelude.startsWith('@')) {
        for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
      }
      segment = '';
    } else if (ch === '}') {
      segment = '';
    } else {
      segment += ch;
    }
  }
  return [...out];
}

/**
 * Class names a TS/JS source puts on elements: `class="…"` in templates, `class:` /
 * `className` assignments of a plain literal, and `classList.add/remove/toggle`.
 * Interpolated parts are dropped, so `class="row ${x}"` yields `row`.
 */
export function markupClasses(source: string): string[] {
  const out = new Set<string>();
  const add = (list: string) => {
    for (const token of list.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (CLASS_NAME.test(token)) out.add(token);
    }
  };
  for (const m of source.matchAll(/\bclass(?:Name)?\s*=\s*"([^"]*)"/g)) add(m[1]);
  for (const m of source.matchAll(/\bclass(?:Name)?\s*=\s*'([^']*)'/g)) add(m[1]);
  for (const m of source.matchAll(/\bclass(?:Name)?\s*:\s*(['"])([^'"`$]*)\1/g)) add(m[2]);
  for (const m of source.matchAll(
    /classList\.(?:add|remove|toggle|contains)\(\s*(['"])([^'"]+)\1/g,
  )) {
    add(m[2]);
  }
  return [...out];
}

export interface CssClassReport {
  /** Defined in project CSS; no string in the source names it or a prefix of it. */
  unused: { name: string; file: string }[];
  /** Put on elements, with no rule in project CSS and not a known SDK class. */
  unstyled: { name: string; file: string }[];
  /** `y-*` names used on elements that the design-token class list does not contain. */
  unknownSdk: { name: string; file: string }[];
}

/**
 * Candidates, not verdicts: a class assembled at runtime from parts that never appear
 * whole, or one used only as a query hook, will show up here.
 *
 * `sdkClasses` is the design-token class list; with none given every `y-*` name counts
 * as styled and `unknownSdk` stays empty.
 */
export function cssClassReport(
  stylesheets: { path: string; text: string }[],
  sources: { path: string; text: string }[],
  sdkClasses: string[] = [],
): CssClassReport {
  const defined = new Map<string, string>();
  for (const { path, text } of stylesheets) {
    for (const name of cssSelectorClasses(text)) if (!defined.has(name)) defined.set(name, path);
  }
  const tokens = new Set<string>();
  const prefixes: string[] = [];
  const used = new Map<string, string>();
  for (const { path, text } of sources) {
    for (const s of scanJs(text).strings) {
      for (const t of s.split(/[^\w-]+/)) {
        if (!t) continue;
        tokens.add(t);
        if (/[-_]$/.test(t) && t.length > 1) prefixes.push(t);
      }
    }
    for (const name of markupClasses(text)) if (!used.has(name)) used.set(name, path);
  }
  const sdk = new Set(sdkClasses);
  const unused: CssClassReport['unused'] = [];
  for (const [name, file] of defined) {
    if (name.startsWith('y-')) continue;
    if (tokens.has(name) || prefixes.some((p) => name.startsWith(p))) continue;
    unused.push({ name, file });
  }
  const unstyled: CssClassReport['unstyled'] = [];
  const unknownSdk: CssClassReport['unknownSdk'] = [];
  for (const [name, file] of used) {
    if (defined.has(name)) continue;
    if (name.startsWith('y-')) {
      if (sdk.size > 0 && !sdk.has(name)) unknownSdk.push({ name, file });
      continue;
    }
    unstyled.push({ name, file });
  }
  return { unused, unstyled, unknownSdk };
}

// ── Worker task scope ───────────────────────────────────────────────────────────

export interface ScopedFile {
  path: string;
  bytes: number;
}

/**
 * The project files a task names: exact paths, directories (every file under them) and
 * globs. What the worker is expected to read, so its size can be judged before it starts
 * and what it never opened can be named after it stops.
 */
export function filesNamedInTask(
  task: string,
  projectFiles: { path: string; isDirectory?: boolean; bytes?: number }[],
): ScopedFile[] {
  const all = projectFiles.filter((f) => !f.isDirectory);
  const picked = new Map<string, number>();
  const take = (f: { path: string; bytes?: number }) => picked.set(f.path, f.bytes ?? 0);
  for (const raw of task.match(/[\w@.\-/*{},]+/g) ?? []) {
    const token = raw.replace(/[.,:;]+$/, '').replace(/^[{,]+/, '');
    if (!token || !/[/.]/.test(token)) continue;
    if (token.includes('*')) {
      let re: RegExp;
      try {
        re = globToRegExp(token);
      } catch {
        continue;
      }
      for (const f of all) if (re.test(f.path)) take(f);
      continue;
    }
    const bare = token.replace(/^\.\//, '').replace(/\/+$/, '');
    const exact = all.find((f) => f.path === bare);
    if (exact) {
      take(exact);
      continue;
    }
    if (!bare.includes('/') && bare.includes('.')) {
      for (const f of all) if (f.path.endsWith('/' + bare)) take(f);
      continue;
    }
    for (const f of all) if (f.path.startsWith(bare + '/')) take(f);
  }
  return [...picked]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Consecutive groups of at most `limit` bytes; a file larger than that stands alone. */
export function splitBySize(files: ScopedFile[], limit: number): ScopedFile[][] {
  const groups: ScopedFile[][] = [];
  let current: ScopedFile[] = [];
  let size = 0;
  for (const f of files) {
    if (current.length > 0 && size + f.bytes > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
