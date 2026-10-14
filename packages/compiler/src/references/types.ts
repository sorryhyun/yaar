/**
 * `findReferences` — the query and the answer, shared by the host, the worker and
 * the server route. Lines and columns are 1-based; paths are sandbox-relative.
 */

export interface FindReferencesQuery {
  /** The file the symbol is declared (or used) in, sandbox-relative — `src/main.ts`. */
  file: string;
  /**
   * A declaration in `file`: `setBlocks`, or `Class.method` / `obj.prop` for a member.
   * With `line`, the first occurrence of that name on the line — declaration or use.
   */
  symbol?: string;
  line?: number;
  column?: number;
  /** Also answer who calls it. Costs a call-hierarchy pass. */
  callers?: boolean;
  /** Cap on `references` and `callers`. Default 200. */
  maxResults?: number;
  /**
   * Leave test files out (`*.test.ts`, `test/`, `__tests__/`). Without it they are still
   * listed after every production reference, so a cap clips tests first.
   */
  excludeTests?: boolean;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface ReferenceDefinition extends SourceLocation {
  name: string;
  kind: string;
}

export interface ReferenceHit extends SourceLocation {
  /** The source line, trimmed. */
  text: string;
  /** The innermost named function or method around it — `Editor.save` — or null at module scope. */
  enclosing: string | null;
  isDefinition?: true;
  isWrite?: true;
  isCall?: true;
  role?: 'import' | 'export';
}

export interface CallerHit {
  /** `Class.method`, `fn`, or `(top level)`. */
  caller: string;
  kind: string;
  file: string;
  line: number;
  calls: { line: number; column: number }[];
}

/**
 * `typeAt` — what the checker says sits at one position: the hover text an editor would
 * show. Named the way `findReferences` names a symbol, minus the result-shaping options.
 */
export type TypeAtQuery = Pick<FindReferencesQuery, 'file' | 'symbol' | 'line' | 'column'>;

export type TypeAtResult =
  | {
      success: true;
      /** The identifier the position landed on. */
      symbol: string;
      at: SourceLocation;
      /** Other declarations the same `symbol` matched — pass `line` to pick one. */
      ambiguous?: SourceLocation[];
      /** `const`, `function`, `method`, `property`, `alias`, … — the checker's element kind. */
      kind: string;
      /**
       * The declaration as the checker prints it: `const rows: Accessor<Row[]>`,
       * `function save(doc: Doc): Promise<void>`. Clipped past a few KB (`truncated`).
       */
      type: string;
      /** The JSDoc summary, when the declaration carries one. */
      documentation?: string;
      /** JSDoc tags (`@param`, `@deprecated`, …) as `name: text`. */
      tags?: string[];
      /** Where the symbol is declared — a file outside the project gets a stable label. */
      definition?: SourceLocation;
      truncated?: true;
    }
  | { success: false; kind: FindReferencesFailureKind; error: string };

export type FindReferencesFailureKind =
  /** No TypeScript in this build (the bundled exe). */
  | 'unavailable'
  /** The query itself is malformed. */
  | 'invalid'
  /** The file is not in the project, or nothing resolvable sits at the position. */
  | 'not-found'
  | 'timeout'
  | 'failed';

export type FindReferencesResult =
  | {
      success: true;
      /** The name the query resolved to. */
      symbol: string;
      /** Where the resolution landed, so an ambiguous `symbol` can be checked. */
      at: SourceLocation;
      /** Other declarations the same `symbol` matched — pass `line` to pick one. */
      ambiguous?: SourceLocation[];
      definitions: ReferenceDefinition[];
      references: ReferenceHit[];
      /**
       * Present when `callers` was asked. `callersFrom: 'call-hierarchy'` is the
       * checker's own answer; `'references'` is derived from call-site references
       * grouped by `enclosing`, the fallback for a symbol call hierarchy cannot start
       * from (a variable holding a function, such as a signal setter).
       */
      callers?: CallerHit[];
      callersFrom?: 'call-hierarchy' | 'references';
      /** References in the project before `maxResults` clipped them. */
      totalReferences: number;
      /** How many of `totalReferences` are in test files — listed last. */
      testReferences: number;
      /** Distinct project files among them. */
      files: number;
      truncated?: true;
    }
  | { success: false; kind: FindReferencesFailureKind; error: string };
