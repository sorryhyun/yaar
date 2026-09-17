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
      /** Distinct project files among them. */
      files: number;
      truncated?: true;
    }
  | { success: false; kind: FindReferencesFailureKind; error: string };
