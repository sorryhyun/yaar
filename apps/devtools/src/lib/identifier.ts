export {};

export interface IdentifierHit {
  name: string;
  /** 1-based line of the identifier's first character. */
  line: number;
  /** 1-based column of the identifier's first character. */
  column: number;
  /** 0-based offsets into the text, end exclusive. */
  start: number;
  end: number;
}

const IDENT_CHAR = /[\w$ -￿]/;

// Reserved words and literal-like names: a language-service lookup on one of these has
// nothing to resolve, so hovering them should show nothing rather than an error.
const NOT_SYMBOLS = new Set(
  (
    'abstract as asserts async await break case catch class const continue debugger declare ' +
    'default delete do else enum export extends false finally for from function if implements ' +
    'import in infer instanceof interface is keyof let namespace new null of private protected ' +
    'public readonly return satisfies static super switch this throw true try type typeof ' +
    'undefined unique var void while with yield any boolean never number object string symbol ' +
    'unknown bigint'
  ).split(' '),
);

/** Whether findReferences can resolve symbols in `path` — it only reads `src/**\/*.ts`. */
export function isReferenceLookupPath(path: string | null): boolean {
  return !!path && path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.d.ts');
}

/**
 * The identifier covering `offset` in `text` (a caret sitting just after one counts), or
 * null when the offset is on whitespace, punctuation, a number, or a reserved word.
 */
export function identifierAt(text: string, offset: number): IdentifierHit | null {
  if (offset < 0 || offset > text.length) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start--;
  while (end < text.length && IDENT_CHAR.test(text[end])) end++;
  if (start === end) return null;
  const name = text.slice(start, end);
  if (/^\d/.test(name) || NOT_SYMBOLS.has(name)) return null;
  const before = text.slice(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  return {
    name,
    line: before.split('\n').length,
    column: start - lineStart + 1,
    start,
    end,
  };
}
