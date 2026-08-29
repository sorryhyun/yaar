/**
 * The app's module graph: what a specifier resolves to, and what a module binds.
 *
 * The layer under the extractor. It answers two questions and holds no state of
 * its own: where does `./commands/git` point (`resolveModulePath`), and what
 * names does that file declare, import, and re-export (`buildScope`).
 *
 * Resolution is deliberately limited to *relative* specifiers within the app. A
 * descriptor reached through `node_modules` or a path alias is refused by the
 * extractor with a location rather than skipped silently, and that refusal rests
 * on `isRelative` being the only door in.
 */

export type TsModule = typeof import('typescript');
export type TsNode = import('typescript').Node;
export type TsExpression = import('typescript').Expression;
export type TsSourceFile = import('typescript').SourceFile;
export type TsObjectLiteral = import('typescript').ObjectLiteralExpression;

/** Reads a module's text, or null when the path does not exist. */
export type ReadFile = (path: string) => string | null;

/** A construct the extractor refused to guess at, with where to find it. */
export interface ProtocolError {
  /** ASCII only — compiler error paths mangle non-ASCII bytes. */
  message: string;
  /** Path as handed to `readFile`, for display. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** Format a `ProtocolError` as `path:line:col: message`. */
export function formatProtocolError(err: ProtocolError): string {
  return `${err.file}:${err.line}:${err.column}: ${err.message}`;
}

export interface Binding {
  /** The initializer expression this name is bound to. */
  node: TsNode;
  /** The module the expression lives in — its own scope for further resolution. */
  scope: ModuleScope;
}

export interface ImportRef {
  /** Raw module specifier as written. */
  specifier: string;
  /** Name in the *target* module; `default` for a default import. */
  imported: string;
  node: TsNode;
}

export interface ModuleScope {
  file: string;
  source: TsSourceFile;
  /**
   * `const x = <expr>` and `function x() {}` at module top level. Function
   * declarations are indexed so a locally-declared wrapper is *found* rather
   * than mistaken for an unresolved package import — see `isTransparentWrapper`.
   */
  locals: Map<string, TsNode>;
  /** Local alias -> where it came from. */
  imports: Map<string, ImportRef>;
  /** `export * from './x'` specifiers, searched as a fallback. */
  starReexports: string[];
  /**
   * Every module specifier this file imports, whether or not it binds a name.
   *
   * The binding map misses two spellings the bundler still pulls in: a
   * side-effect import (`import './protocol'` — how one shipped app performs its
   * registration) and a namespace import (`import * as yaar`). Walking only
   * bound names left those modules outside the graph, so a registration in one
   * was invisible and reported as "this app declares no protocol".
   */
  allImports: string[];
}

export const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx'];

/** Recursion ceiling when walking relative imports. Apps are far shallower. */
export const MAX_MODULE_DEPTH = 200;

/** Strip the last path segment. Paths are always forward-slash here. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

/** Resolve `./a/../b` style segments without touching the filesystem. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  const prefix = path.startsWith('/') ? '/' : '';
  return prefix + out.join('/');
}

/**
 * Resolve a relative specifier against the importing file, trying the extension
 * candidates a bundler would. Returns the first path `readFile` can serve.
 *
 * A `.js` specifier maps to its `.ts` source: server code uses ESM `.js`
 * extensions, and an app may copy that habit.
 */
export function resolveModulePath(
  fromFile: string,
  specifier: string,
  readFile: ReadFile,
): string | null {
  const base = normalizePath(`${dirname(fromFile)}/${specifier}`);
  const candidates: string[] = [];

  const jsMatch = base.match(/^(.*)\.(js|jsx|mjs)$/);
  if (jsMatch) candidates.push(`${jsMatch[1]}.ts`, `${jsMatch[1]}.tsx`);

  if (MODULE_EXTENSIONS.some((ext) => base.endsWith(ext))) candidates.push(base);
  for (const ext of MODULE_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of MODULE_EXTENSIONS) candidates.push(`${base}/index${ext}`);

  for (const candidate of candidates) {
    if (readFile(candidate) !== null) return candidate;
  }
  return null;
}

/** True for specifiers that point inside the app rather than at a package. */
export function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Index a module's top-level `const` bindings and imports. */
export function buildScope(ts: TsModule, file: string, text: string): ModuleScope {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope: ModuleScope = {
    file,
    source,
    locals: new Map(),
    imports: new Map(),
    starReexports: [],
    allImports: [],
  };

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      // `const` only. A `let`/`var` initializer is not the binding's value —
      // a later reassignment would make the manifest disagree with the runtime
      // while looking perfectly well-formed. Leaving them unindexed turns that
      // into an unresolved-identifier error instead.
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          scope.locals.set(decl.name.text, decl.initializer);
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      scope.locals.set(statement.name.text, statement);
      continue;
    }

    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      scope.allImports.push(specifier);
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        scope.imports.set(clause.name.text, { specifier, imported: 'default', node: clause.name });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          scope.imports.set(element.name.text, {
            specifier,
            imported: (element.propertyName ?? element.name).text,
            node: element,
          });
        }
      }
      continue;
    }

    // `export { x } from './y'` re-binds a name; `export * from './y'` is a
    // fallback search target.
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!statement.exportClause) {
        scope.starReexports.push(specifier);
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          scope.imports.set(element.name.text, {
            specifier,
            imported: (element.propertyName ?? element.name).text,
            node: element,
          });
        }
      }
    }
  }

  return scope;
}
