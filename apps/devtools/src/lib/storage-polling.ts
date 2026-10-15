export {};
import { scanJs } from './source-scan';

// Pure: timer loops that re-read app storage, the shape of an app waiting for another
// window's write. Storage writes already notify: `subscribe(uri, cb)` or
// `appDb.createReactiveCollection` deliver the change, while a one-second poll from four
// windows once made ~98% of a session log.
//
// Heuristic and deliberately narrow, so a hit is worth reading: a `setInterval` whose
// callback reads storage, or a function that reads storage and re-arms itself through
// `setTimeout`. "Reads storage" looks one call deep, at functions declared in the same
// file. A read built from a runtime URI, or reached through an import, is not seen.

export interface StoragePoll {
  file: string;
  line: number;
  timer: 'setInterval' | 'setTimeout';
  /** The storage read the loop reaches, as written: `appStorage.readJson(`. */
  read: string;
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const TIMER = /(?<![\w$.])(?:window\s*\.\s*|globalThis\s*\.\s*)?(setInterval|setTimeout)\s*\(/g;
const STORAGE_READS = [
  /(?<![\w$])(?:appStorage|sharedStorage)\s*\.\s*(?:read\w*|list)\s*\(/,
  /(?<![\w$])(?:yaar\s*\.\s*)?(?:read|list)\s*(?:<[^<>()]*>)?\s*\(\s*['"`]yaar:\/\/(?:storage\/|apps\/self\/(?:storage|db)\b)/,
  /(?<![\w$])appDb\s*\.\s*collection\s*\([^)]*\)\s*\.\s*(?:find|get|count|search)\s*\(/,
];
const COLLECTION_HANDLE = new RegExp(
  String.raw`(?<![\w$])(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]+)?=\s*appDb\s*\.\s*collection\s*\(`,
  'g',
);
const FUNCTION_DECL = new RegExp(
  String.raw`(?<![\w$])(?:function\s*\*?\s*(${IDENT})\s*(?:<[^>]*>)?\s*\(|` +
    String.raw`(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:function\b[^(]*)?\()`,
  'g',
);

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Offset just past the bracket that closes the one at `open`, skipping string literals. */
function closeOf(code: string, open: number, inString: (i: number) => number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const skip = inString(i);
    if (skip > i) {
      i = skip - 1;
      continue;
    }
    const ch = code[i];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return code.length;
}

/** Every storage read in one source file's timer loops. */
export function storagePollsIn(file: string, source: string): StoragePoll[] {
  const scanned = scanJs(source);
  const code = scanned.masked ?? source;
  const spans = scanned.stringSpans ?? [];
  const inString = (i: number): number => {
    for (const [s, e] of spans) if (i >= s && i < e) return e;
    return i;
  };

  const bodies = new Map<string, { start: number; text: string }>();
  for (const m of code.matchAll(FUNCTION_DECL)) {
    const name = m[1] ?? m[2];
    const paramsEnd = closeOf(code, m.index + m[0].length - 1, inString);
    const rest = /^\s*(?::[^={]+)?(?:=>)?\s*/.exec(code.slice(paramsEnd))!;
    const start = paramsEnd + rest[0].length;
    const end =
      code[start] === '{'
        ? closeOf(code, start, inString)
        : code.slice(start).search(/[;\n]|$/) + start;
    if (!bodies.has(name)) bodies.set(name, { start: m.index, text: code.slice(m.index, end) });
  }

  const reads = [...STORAGE_READS];
  for (const m of code.matchAll(COLLECTION_HANDLE)) {
    reads.push(new RegExp(String.raw`(?<![\w$.])${m[1]}\s*\.\s*(?:find|get|count|search)\s*\(`));
  }
  const readIn = (text: string): string | null => {
    for (const re of reads) {
      const hit = re.exec(text);
      if (hit) return hit[0].replace(/\s+/g, '');
    }
    return null;
  };
  /** A read in `text`, or in a same-file function it calls. */
  const reaches = (text: string, self?: string): string | null => {
    const direct = readIn(text);
    if (direct) return direct;
    for (const [, callee] of text.matchAll(
      new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*\(`, 'g'),
    )) {
      if (callee === self) continue;
      const body = bodies.get(callee);
      const hit = body && readIn(body.text);
      if (hit) return hit;
    }
    return null;
  };

  const polls: StoragePoll[] = [];
  for (const m of code.matchAll(TIMER)) {
    if (inString(m.index) > m.index) continue;
    const timer = m[1] as StoragePoll['timer'];
    const open = m.index + m[0].length - 1;
    const args = code.slice(open + 1, closeOf(code, open, inString) - 1);
    const named = new RegExp(String.raw`^\s*(${IDENT})\s*(?:,|$)`).exec(args)?.[1];
    let read: string | null = null;
    if (timer === 'setInterval') {
      const body = named ? bodies.get(named)?.text : args;
      read = body ? reaches(body, named) : null;
    } else {
      // A timeout polls only when it re-arms the function it sits in (or names).
      const owner = [...bodies.entries()].find(
        ([name, b]) =>
          m.index > b.start &&
          m.index < b.start + b.text.length &&
          new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`).test(args),
      );
      if (owner) read = reaches(owner[1].text, owner[0]);
    }
    if (read) polls.push({ file, line: lineAt(source, m.index), timer, read });
  }
  return polls;
}

export function findStoragePolling(sources: { path: string; text: string }[]): StoragePoll[] {
  return sources.flatMap((s) => storagePollsIn(s.path, s.text));
}
