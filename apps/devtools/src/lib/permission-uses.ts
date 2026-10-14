export {};
import { scanJs } from './source-scan';

// Pure: which `yaar://` verbs an app's source performs, read lexically, so the server can
// say which of them app.json does not grant — before a preview turns one into a 403.
//
// Only what can be read whole is reported: a call whose URI is a string literal, or a
// `const` in the same file holding one; and the HTTP door, which `httpFetch` and a
// cross-origin `fetch` go through. A URI assembled at runtime (`yaar://windows/${id}`) is
// skipped rather than guessed at: a prefix is not the URI, and judging the prefix would
// report grants the real call does not need.

export type UseVerb = 'read' | 'list' | 'invoke' | 'delete';

export interface VerbUse {
  verb: UseVerb;
  uri: string;
  file: string;
  line: number;
  /** The call the use was read from — `read`, `httpFetch`, `fetch`. */
  via: string;
}

/** `@bundled/yaar`'s verb functions, by the permission each one needs. */
const CALL_VERB: Record<string, UseVerb> = {
  read: 'read',
  list: 'list',
  invoke: 'invoke',
  del: 'delete',
  // A subscription is gated as a read of what it watches.
  subscribe: 'read',
};

const URI = String.raw`yaar:\/\/[^'"\x60$\\\s]*`;
/** A quoted `yaar://` literal; the URI is the `uri` group. */
const QUOTED = String.raw`(?<q>['"\x60])(?<uri>${URI})\k<q>`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

const CONST_URI = new RegExp(
  String.raw`(?<![\w$])const\s+(?<name>${IDENT})\s*(?::[^=;]+)?=\s*${QUOTED}`,
  'g',
);
const VERB_CALL = new RegExp(
  String.raw`(?<![\w$])(?<fn>read|list|invoke|del|subscribe)\s*(?:<[^<>()]*>)?\s*\(\s*` +
    String.raw`(?:${QUOTED}|(?<ref>${IDENT}))\s*[,)]`,
  'g',
);
const HTTP_FETCH = /(?<![\w$])httpFetch\s*\(\s*(['"`]?)(\S{0,2})/g;
const CROSS_ORIGIN_FETCH = /(?<![\w$])fetch\s*\(\s*['"`]https?:\/\//g;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The verb uses one source file performs, in source order. */
export function verbUsesIn(file: string, source: string): VerbUse[] {
  const scanned = scanJs(source);
  const code = scanned.masked ?? source;
  const spans = scanned.stringSpans ?? [];
  // A call is code: one that starts inside a string literal is text that looks like one.
  const inString = (offset: number) => spans.some(([a, b]) => offset >= a && offset < b);
  const consts = new Map<string, string>();
  for (const m of code.matchAll(CONST_URI)) consts.set(m.groups!.name, m.groups!.uri);

  const uses: VerbUse[] = [];
  const add = (verb: UseVerb, uri: string, offset: number, via: string) => {
    if (!inString(offset)) uses.push({ verb, uri, file, line: lineAt(code, offset), via });
  };

  for (const m of code.matchAll(VERB_CALL)) {
    const { fn, uri: literal, ref } = m.groups!;
    const uri = literal ?? consts.get(ref ?? '');
    if (uri) add(CALL_VERB[fn], uri, m.index, fn);
  }
  for (const m of code.matchAll(HTTP_FETCH)) {
    // A literal relative URL is same-origin and needs no grant.
    if (m[1] && /^\.?\//.test(m[2])) continue;
    add('invoke', 'yaar://http', m.index, 'httpFetch');
  }
  for (const m of code.matchAll(CROSS_ORIGIN_FETCH)) add('invoke', 'yaar://http', m.index, 'fetch');

  return uses.sort((a, b) => a.line - b.line);
}

/** Every use across files, and the distinct verb/URI pairs to ask the server about. */
export function collectVerbUses(files: { path: string; text: string }[]): {
  uses: VerbUse[];
  distinct: { verb: UseVerb; uri: string }[];
} {
  const uses = files.flatMap((f) => verbUsesIn(f.path, f.text));
  const seen = new Map<string, { verb: UseVerb; uri: string }>();
  for (const u of uses) seen.set(`${u.verb} ${u.uri}`, { verb: u.verb, uri: u.uri });
  return { uses, distinct: [...seen.values()] };
}
