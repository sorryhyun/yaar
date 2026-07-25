/**
 * Extract App Protocol manifest from TypeScript source using the TypeScript AST.
 *
 * This is the only reader of an `app.register()` protocol. It replaced a
 * brace-matching text scanner (deleted), and the difference that matters is not
 * accuracy on the shapes that scanner already handled — it is *reach*:
 *
 *   - descriptor maps may live in other files and arrive via `...spread`;
 *   - a descriptor may be a `const` referenced by name;
 *   - `params`/`returns`/`schema` blocks may contain `+`-concatenated strings,
 *     which the text scanner silently dropped from the manifest.
 *
 * That reach is the whole point: it makes a protocol file decomposable by domain
 * without the manifest quietly losing entries. See
 * `docs/proposals/app_protocol_manifest_proposal.md`.
 *
 * The invariant this module exists to hold: **an entry that works at runtime must
 * be visible in the static manifest.** So anything it cannot resolve is a hard
 * error with a source location, never a best-effort omission. A command an agent
 * cannot see is a command that does not exist.
 *
 * Module resolution is deliberately limited to *relative* imports within the app.
 * A descriptor reached through `node_modules` or a path alias is an error rather
 * than a silent skip. `defineCommand({...})` is transparent because the shim's
 * `defineCommand` is the identity function; any other wrapper must be provably
 * an identity function in this app, or it is an error (see
 * `isTransparentWrapper`).
 */

import type { AppManifest } from '@yaar/shared';

type TsModule = typeof import('typescript');
type TsNode = import('typescript').Node;
type TsExpression = import('typescript').Expression;
type TsSourceFile = import('typescript').SourceFile;
type TsObjectLiteral = import('typescript').ObjectLiteralExpression;

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events'>;

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

export interface AstProtocolExtraction {
  protocol: Protocol | null;
  errors: ProtocolError[];
  /**
   * Descriptor schema paths (`commands.add.params`) that are not compile-time
   * constants and are expected to be Zod — the ones `fold-schemas.ts` must fill
   * in by running the app. Only `defineApp` produces these; the legacy shape has
   * no default export to read a schema back out of, so a non-constant schema
   * stays a hard error there.
   *
   * Non-empty means `protocol` is *incomplete*, not wrong: every entry is
   * present, and the listed schemas are absent until the fold supplies them.
   */
  pendingFolds: string[];
  /** True when the manifest came from `export default defineApp({...})`. */
  usesDefineApp: boolean;
}

/** Reads a module's text, or null when the path does not exist. */
export type ReadFile = (path: string) => string | null;

/** Format a `ProtocolError` as `path:line:col: message`. */
export function formatProtocolError(err: ProtocolError): string {
  return `${err.file}:${err.line}:${err.column}: ${err.message}`;
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

interface Binding {
  /** The initializer expression this name is bound to. */
  node: TsNode;
  /** The module the expression lives in — its own scope for further resolution. */
  scope: ModuleScope;
}

interface ImportRef {
  /** Raw module specifier as written. */
  specifier: string;
  /** Name in the *target* module; `default` for a default import. */
  imported: string;
  node: TsNode;
}

interface ModuleScope {
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

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx'];

/** Recursion ceiling when folding a value. A JSON Schema nests a few levels. */
const MAX_VALUE_DEPTH = 100;

/** Recursion ceiling when walking relative imports. Apps are far shallower. */
const MAX_MODULE_DEPTH = 200;

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
function resolveModulePath(fromFile: string, specifier: string, readFile: ReadFile): string | null {
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
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Index a module's top-level `const` bindings and imports. */
function buildScope(ts: TsModule, file: string, text: string): ModuleScope {
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

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

class Extractor {
  private readonly scopes = new Map<string, ModuleScope | null>();
  readonly errors: ProtocolError[] = [];
  /** See `AstProtocolExtraction.pendingFolds`. */
  readonly pendingFolds: string[] = [];

  constructor(
    private readonly ts: TsModule,
    private readonly readFile: ReadFile,
  ) {}

  // -- diagnostics ---------------------------------------------------------

  /**
   * Discard every error recorded since `mark`.
   *
   * Used for exactly one thing: a descriptor schema that failed to fold
   * statically and will be handed to the runtime fold instead. The evaluator
   * reports as it goes, so "try, and on failure defer" needs the report undone —
   * otherwise adopting a Zod schema would fail the build with a message about a
   * function call that is not a mistake. Any caller that does not go on to
   * record a `pendingFolds` entry is dropping a real diagnostic.
   */
  rollbackErrors(mark: number): void {
    this.errors.length = mark;
  }

  error(scope: ModuleScope, node: TsNode, message: string): void {
    const { line, character } = scope.source.getLineAndCharacterOfPosition(node.getStart());
    this.errors.push({
      message,
      file: scope.file,
      line: line + 1,
      column: character + 1,
    });
  }

  // -- module loading ------------------------------------------------------

  loadScope(file: string): ModuleScope | null {
    const cached = this.scopes.get(file);
    if (cached !== undefined) return cached;
    // Seed the cache before parsing so an import cycle terminates.
    this.scopes.set(file, null);
    const text = this.readFile(file);
    if (text === null) return null;
    let scope: ModuleScope;
    try {
      scope = buildScope(this.ts, file, text);
    } catch (err) {
      // `ts.createSourceFile` recurses over nesting depth and throws a stackless
      // RangeError on pathological input. Left unhandled it surfaces as an
      // unattributed compile failure; naming the file is the whole difference.
      this.errors.push({
        message: `could not be parsed (${err instanceof Error ? err.name : 'unknown error'})`,
        file,
        line: 1,
        column: 1,
      });
      return null;
    }
    this.scopes.set(file, scope);
    return scope;
  }

  /** Every module reachable from `entry` through relative imports, entry first. */
  moduleGraph(entry: string): ModuleScope[] {
    const seen = new Set<string>();
    const out: ModuleScope[] = [];
    const walk = (file: string, depth = 0): void => {
      if (seen.has(file)) return;
      // `seen` stops cycles but not a deep acyclic chain, and this is the only
      // recursive path here without a bound. Unbounded, it throws a raw
      // RangeError that surfaces as an unattributed build failure.
      if (depth > MAX_MODULE_DEPTH) {
        this.errors.push({
          message: `import chain is deeper than ${MAX_MODULE_DEPTH} modules`,
          file,
          line: 1,
          column: 1,
        });
        return;
      }
      seen.add(file);
      const scope = this.loadScope(file);
      if (!scope) return;
      out.push(scope);
      const specifiers = [
        ...scope.allImports,
        ...[...scope.imports.values()].map((i) => i.specifier),
        ...scope.starReexports,
      ];
      for (const specifier of specifiers) {
        if (!isRelative(specifier)) continue;
        const resolved = resolveModulePath(file, specifier, this.readFile);
        if (resolved) walk(resolved, depth + 1);
      }
    };
    walk(entry);
    return out;
  }

  // -- name resolution -----------------------------------------------------

  /**
   * Follow an identifier to the expression it is bound to, across relative
   * imports. Returns null when the binding leaves the app (a package import) or
   * does not exist.
   */
  resolveBinding(name: string, scope: ModuleScope, depth = 0): Binding | null {
    if (depth > 16) return null; // pathological alias chain

    const local = scope.locals.get(name);
    if (local) return { node: local, scope };

    const imported = scope.imports.get(name);
    if (imported) {
      if (!isRelative(imported.specifier)) return null;
      const path = resolveModulePath(scope.file, imported.specifier, this.readFile);
      if (!path) return null;
      const target = this.loadScope(path);
      if (!target) return null;
      if (imported.imported === 'default') return null;
      return this.resolveBinding(imported.imported, target, depth + 1);
    }

    for (const specifier of scope.starReexports) {
      if (!isRelative(specifier)) continue;
      const path = resolveModulePath(scope.file, specifier, this.readFile);
      if (!path) continue;
      const target = this.loadScope(path);
      if (!target) continue;
      const found = this.resolveBinding(name, target, depth + 1);
      if (found) return found;
    }

    return null;
  }

  /**
   * Resolve an identifier the way JavaScript does: nearest enclosing binding
   * first, module scope last.
   *
   * Without this, only module-level `const`s were indexed, so an identifier
   * shadowed by a local would resolve to the *module-level* binding of the same
   * name — a manifest that disagrees with the runtime and says nothing about it.
   * That is the one failure this extractor may not have.
   *
   * A local binding we cannot read as a constant (a parameter, a destructuring
   * pattern, a `let` reassigned later) returns `shadowed`, which callers turn
   * into a hard error rather than falling back to the module binding.
   */
  resolveIdentifier(
    id: import('typescript').Identifier,
    scope: ModuleScope,
  ): Binding | 'shadowed' | null {
    const ts = this.ts;
    const name = id.text;

    for (let node: TsNode | undefined = id.parent; node; node = node.parent) {
      // Parameters shadow everything inside the function they belong to.
      if (ts.isFunctionLike(node)) {
        for (const param of node.parameters) {
          if (ts.isIdentifier(param.name) && param.name.text === name) return 'shadowed';
          if (!ts.isIdentifier(param.name)) {
            // A destructuring parameter may bind `name`; we cannot tell cheaply.
            if (param.name.getText().includes(name)) return 'shadowed';
          }
        }
      }

      const statements = ts.isSourceFile(node)
        ? null // module scope is `resolveBinding`'s job — it also knows imports
        : ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node)
          ? node.statements
          : null;
      if (!statements) continue;

      for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
          if (statement.name?.text === name) return 'shadowed';
          continue;
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            if (decl.name.getText().includes(name)) return 'shadowed';
            continue;
          }
          if (decl.name.text !== name) continue;
          const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
          if (!isConst || !decl.initializer) return 'shadowed';
          return { node: decl.initializer, scope };
        }
      }
    }

    return this.resolveBinding(name, scope);
  }

  /**
   * True when `callee(x)` can be read as `x`.
   *
   * Stepping over *any* single-argument call is what the old text scanner did,
   * and it is wrong: a wrapper that decorates its argument
   * (`withDeprecation(cmd)` returning a modified description) would be reported
   * with the pre-decoration text — a manifest that disagrees with the runtime
   * and gives no sign of it.
   *
   * Two things qualify. `defineCommand` is the SDK's declared identity helper
   * (`shims/yaar/ui.ts`), which apps import from a package the extractor
   * deliberately will not follow. Anything else must resolve, inside this app,
   * to a literal identity function.
   */
  isTransparentWrapper(callee: import('typescript').Identifier, scope: ModuleScope): boolean {
    // Anything this app declares must prove itself, whatever it is named. The
    // name check below is trusted only for a callee that resolves to nothing
    // here — i.e. one that came from a package. Trusting the bare name first
    // would let a locally-declared `function defineCommand` that decorates its
    // argument pass unexamined, which is the exact hole this method closes for
    // every other name.
    const bound = this.resolveIdentifier(callee, scope);
    if (bound === 'shadowed') return false;
    if (bound) return this.isIdentityFunction(bound.node);

    // Undeclared in the app, so it is imported from a package the extractor
    // deliberately does not follow. Only the SDK's documented identity helpers
    // (`shims/yaar/ui.ts`) are trusted by name.
    return callee.text === 'defineCommand' || callee.text === 'defineAppCommand';
  }

  /** True for `(d) => d`, `function (d) { return d; }`, and equivalents. */
  isIdentityFunction(fn: TsNode): boolean {
    const ts = this.ts;
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) {
      return false;
    }
    if (fn.parameters.length !== 1) return false;
    const param = fn.parameters[0];
    if (!ts.isIdentifier(param.name)) return false;

    const body = !fn.body
      ? undefined
      : ts.isBlock(fn.body)
        ? fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
          ? fn.body.statements[0].expression
          : undefined
        : fn.body;
    return !!body && ts.isIdentifier(body) && body.text === param.name.text;
  }

  /**
   * Strip the wrappers that do not change a value: parentheses, `as const`,
   * `satisfies`, non-null `!`, and identity calls such as `defineCommand({...})`.
   *
   * Sets `shadowed` when resolution hit a local binding it could not read; the
   * node is returned unresolved so the caller reports it with a location.
   */
  unwrap(node: TsNode, scope: ModuleScope): { node: TsNode; scope: ModuleScope } {
    const ts = this.ts;
    let current = node;
    let currentScope = scope;

    for (let i = 0; i < 32; i++) {
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.arguments.length === 1 &&
        this.isTransparentWrapper(current.expression, currentScope)
      ) {
        current = current.arguments[0];
        continue;
      }
      if (ts.isIdentifier(current)) {
        const bound = this.resolveIdentifier(current, currentScope);
        if (bound === 'shadowed' || !bound) return { node: current, scope: currentScope };
        current = bound.node;
        currentScope = bound.scope;
        continue;
      }
      break;
    }
    return { node: current, scope: currentScope };
  }

  // -- value evaluation ----------------------------------------------------

  /**
   * Evaluate an expression to a JSON value. Returns `undefined` and records an
   * error when the expression is not a compile-time constant.
   *
   * `label` names the property being evaluated so the message says what broke.
   */
  evaluate(node: TsNode, scope: ModuleScope, label: string, depth = 0): unknown {
    const ts = this.ts;
    // A JSON Schema nests a few levels; thousands means generated or hostile
    // input, and unbounded recursion here overflows the stack and takes the
    // whole compile down with an unattributed RangeError.
    if (depth > MAX_VALUE_DEPTH) {
      this.error(scope, node, `\`${label}\`: value nests deeper than ${MAX_VALUE_DEPTH} levels`);
      return undefined;
    }
    const { node: expr, scope: exprScope } = this.unwrap(node, scope);

    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expr.kind === ts.SyntaxKind.NullKeyword) return null;

    if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
      const value = Number(expr.operand.text);
      if (expr.operator === ts.SyntaxKind.MinusToken) return -value;
      if (expr.operator === ts.SyntaxKind.PlusToken) return value;
    }

    // `'a' + 'b'` — descriptions routinely exceed the line limit and get written
    // as adjacent literals joined by `+`.
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.evaluate(expr.left, exprScope, label, depth + 1);
      if (left === undefined) return undefined;
      const right = this.evaluate(expr.right, exprScope, label, depth + 1);
      if (right === undefined) return undefined;
      if (
        (typeof left === 'string' || typeof left === 'number') &&
        (typeof right === 'string' || typeof right === 'number')
      ) {
        return typeof left === 'number' && typeof right === 'number'
          ? left + right
          : `${left}${right}`;
      }
      this.error(exprScope, expr, `\`${label}\`: cannot concatenate non-primitive values`);
      return undefined;
    }

    if (ts.isTemplateExpression(expr)) {
      this.error(
        exprScope,
        expr,
        `\`${label}\`: template literals with \${...} substitutions are not statically ` +
          `resolvable; use a plain string or \`+\` concatenation of literals`,
      );
      return undefined;
    }

    if (ts.isArrayLiteralExpression(expr)) {
      const out: unknown[] = [];
      for (const element of expr.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.evaluate(element.expression, exprScope, label, depth + 1);
          if (spread === undefined) return undefined;
          if (!Array.isArray(spread)) {
            this.error(exprScope, element, `\`${label}\`: spread element is not an array`);
            return undefined;
          }
          out.push(...spread);
          continue;
        }
        const value = this.evaluate(element, exprScope, label, depth + 1);
        if (value === undefined) return undefined;
        out.push(value);
      }
      return out;
    }

    if (ts.isObjectLiteralExpression(expr)) {
      const entries = this.flattenObject(expr, exprScope, label);
      if (entries === null) return undefined;
      const out: Record<string, unknown> = {};
      for (const entry of entries) {
        const value = this.evaluate(entry.value, entry.scope, `${label}.${entry.key}`, depth + 1);
        if (value === undefined) return undefined;
        out[entry.key] = value;
      }
      return out;
    }

    this.error(
      exprScope,
      expr,
      `\`${label}\`: value is not a compile-time constant ` +
        `(${this.describeNode(expr)}); the manifest must be statically extractable`,
    );
    return undefined;
  }

  /** A short, ASCII, human-readable name for what a node is. */
  describeNode(node: TsNode): string {
    const ts = this.ts;
    if (ts.isIdentifier(node)) return `unresolved identifier \`${node.text}\``;
    if (ts.isPropertyAccessExpression(node)) return 'a property access';
    if (ts.isCallExpression(node)) return 'a function call';
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 'a function';
    if (ts.isConditionalExpression(node)) return 'a conditional expression';
    if (ts.isSpreadAssignment(node)) return 'a spread';
    return 'a non-literal expression';
  }

  // -- object literals -----------------------------------------------------

  /**
   * Flatten an object literal into ordered key/value entries, resolving
   * `...spread` operands to their own literals. Later keys win, matching JS.
   *
   * Returns null when any part could not be resolved — errors are already
   * recorded. A partial result is never returned: a half-read `commands` block
   * is exactly the silent truncation this module exists to prevent.
   *
   * `allowMethods` records a method shorthand as an entry instead of rejecting
   * it. `defineApp` config uses it: `onClose() {...}` and `run(p) {...}` are
   * ordinary ways to write a lifecycle hook and a handler, and neither is a
   * value the manifest reads. It stays off for `app.register()`, where the
   * rejection message is the documented fix for `ping() {...}`-shaped
   * pseudo-descriptors.
   */
  flattenObject(
    literal: TsObjectLiteral,
    scope: ModuleScope,
    label: string,
    depth = 0,
    allowMethods = false,
  ): Array<{ key: string; value: TsNode; scope: ModuleScope }> | null {
    const ts = this.ts;
    if (depth > 16) {
      this.error(scope, literal, `\`${label}\`: spread nesting is too deep to resolve`);
      return null;
    }

    const entries: Array<{ key: string; value: TsNode; scope: ModuleScope }> = [];
    let failed = false;

    for (const prop of literal.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const { node: target, scope: targetScope } = this.unwrap(prop.expression, scope);
        if (!ts.isObjectLiteralExpression(target)) {
          this.error(
            scope,
            prop,
            `\`${label}\`: spread source could not be resolved to an object literal ` +
              `(${this.describeNode(target)}); spreads must name a \`const\` object literal ` +
              `declared in this app and imported with a relative path`,
          );
          failed = true;
          continue;
        }
        const nested = this.flattenObject(target, targetScope, label, depth + 1, allowMethods);
        if (nested === null) {
          failed = true;
          continue;
        }
        entries.push(...nested);
        continue;
      }

      if (ts.isPropertyAssignment(prop)) {
        const key = this.propertyKey(prop.name, scope, label);
        if (key === null) {
          failed = true;
          continue;
        }
        entries.push({ key, value: prop.initializer, scope });
        continue;
      }

      if (ts.isShorthandPropertyAssignment(prop)) {
        const bound = this.resolveIdentifier(prop.name, scope);
        if (bound === 'shadowed' || !bound) {
          this.error(
            scope,
            prop,
            `\`${label}\`: shorthand property \`${prop.name.text}\` could not be resolved ` +
              `to a value declared in this app`,
          );
          failed = true;
          continue;
        }
        entries.push({ key: prop.name.text, value: bound.node, scope: bound.scope });
        continue;
      }

      if (ts.isMethodDeclaration(prop)) {
        if (allowMethods) {
          const key = this.propertyKey(prop.name, scope, label);
          if (key === null) {
            failed = true;
            continue;
          }
          entries.push({ key, value: prop, scope });
          continue;
        }
        this.error(
          scope,
          prop,
          `\`${label}\`: method shorthand is not a descriptor; write ` +
            `\`name: { description, handler }\` or \`name: defineCommand({...})\``,
        );
        failed = true;
        continue;
      }

      this.error(scope, prop, `\`${label}\`: unsupported property (${this.describeNode(prop)})`);
      failed = true;
    }

    if (failed) return null;

    // Later keys win, but keep first-seen order so the manifest reads like source.
    const byKey = new Map<string, { key: string; value: TsNode; scope: ModuleScope }>();
    for (const entry of entries) byKey.set(entry.key, entry);
    return [...byKey.values()];
  }

  /** Read a property name, rejecting computed keys that are not literal. */
  propertyKey(name: TsNode, scope: ModuleScope, label: string): string | null {
    const ts = this.ts;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      const value = this.evaluate(name.expression, scope, `${label}[computed key]`);
      if (typeof value === 'string') return value;
      if (value !== undefined) return String(value);
      return null;
    }
    this.error(scope, name, `\`${label}\`: unsupported property name`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

/**
 * Find the app's `app.register({...})` call in any module reachable from the entry.
 *
 * `register` is a common method name — `Chart.register(...registerables)` sits in
 * a bundled app today — so the receiver must be the SDK's `app` object: the bare
 * `app` identifier, or a member chain ending in `.app` (`window.yaar.app`).
 * Matching every `.register` call made an unrelated library call the extraction
 * target and failed the build.
 *
 * A receiver we can't attribute is not silently accepted either: candidates whose
 * argument already resolves to an object literal are taken as a fallback, so an
 * app that aliases the SDK object still works, while an unrelated call (whose
 * argument is a spread or a function) is passed over.
 */
function findRegisterCall(
  ts: TsModule,
  scopes: ModuleScope[],
  extractor: Extractor,
): { args: TsExpression; scope: ModuleScope } | null {
  const isAppReceiver = (receiver: TsExpression): boolean => {
    if (ts.isIdentifier(receiver)) return receiver.text === 'app';
    if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text === 'app';
    return false;
  };

  const fallbacks: Array<{ args: TsExpression; scope: ModuleScope }> = [];

  for (const scope of scopes) {
    const candidates: Array<{ args: TsExpression; isApp: boolean }> = [];
    const visit = (node: TsNode): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register' &&
        node.arguments.length >= 1 &&
        !ts.isSpreadElement(node.arguments[0])
      ) {
        candidates.push({
          args: node.arguments[0],
          isApp: isAppReceiver(node.expression.expression),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope.source, visit);

    for (const candidate of candidates) {
      if (candidate.isApp) return { args: candidate.args, scope };
      // A fallback must actually look like a registration. Accepting any object
      // literal let an unrelated `plugin.register({ hooks })` win the search and
      // the real protocol go unreported, with no error to show for it.
      const { node } = extractor.unwrap(candidate.args, scope);
      if (!ts.isObjectLiteralExpression(node)) continue;
      const names = new Set(
        node.properties
          .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
          .filter((n): n is string => n !== null),
      );
      if (names.has('appId') || names.has('commands') || names.has('state')) {
        fallbacks.push({ args: candidate.args, scope });
      }
    }
  }

  // One unambiguous candidate is a usable guess. Two is not: picking the first
  // silently discards a real registration, with nothing to show that a choice
  // was even made. Ambiguity is a question for the author, not a coin flip.
  if (fallbacks.length > 1) {
    const first = fallbacks[0];
    extractor.error(
      first.scope,
      first.args,
      `found ${fallbacks.length} registration-shaped \`.register({...})\` calls and none ` +
        `on the SDK's \`app\` object, so which one declares the protocol is ambiguous; ` +
        `call \`app.register({...})\` on the object imported from '@bundled/yaar'`,
    );
    return null;
  }

  return fallbacks[0] ?? null;
}

// ---------------------------------------------------------------------------
// defineApp
// ---------------------------------------------------------------------------

/** The package `defineApp` must come from for a call to be the SDK's. */
const YAAR_SDK_SPECIFIER = '@bundled/yaar';

/** True when `name` is bound in `scope` to `defineApp` from '@bundled/yaar'. */
function isDefineAppImport(scope: ModuleScope, name: string): boolean {
  const ref = scope.imports.get(name);
  return !!ref && ref.imported === 'defineApp' && ref.specifier === YAAR_SDK_SPECIFIER;
}

/** True when any module in the graph imports the SDK's `defineApp`. */
function importsDefineApp(scopes: ModuleScope[]): boolean {
  for (const scope of scopes) {
    for (const ref of scope.imports.values()) {
      if (ref.imported === 'defineApp' && ref.specifier === YAAR_SDK_SPECIFIER) return true;
    }
  }
  return false;
}

/**
 * True for a call this app makes to the SDK's `defineApp`.
 *
 * The named import is the canonical spelling and is matched exactly, aliases
 * included (`import { defineApp as makeApp }`). A `*.defineApp(...)` member call
 * is also taken, because a namespace import (`import * as yaar`) is not indexed
 * as a binding and would otherwise slip past into the legacy path — which finds
 * no `register()` and reports *no protocol at all*, the silent outcome this
 * module exists to prevent. An app that declares its own `defineApp` is not
 * matched: it resolves locally, so it is that app's function, not the SDK's.
 */
function isDefineAppCall(ts: TsModule, node: TsNode, scope: ModuleScope): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (isDefineAppImport(scope, callee.text)) return true;
    // Undeclared and unimported in this app: a global the extractor cannot see
    // the definition of. Only the SDK's documented name is assumed.
    return (
      callee.text === 'defineApp' &&
      !scope.locals.has('defineApp') &&
      !scope.imports.has('defineApp')
    );
  }
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'defineApp';
  return false;
}

/** The `export default <expr>` expression of a module, if it has one. */
function defaultExportExpression(ts: TsModule, scope: ModuleScope): TsExpression | null {
  for (const statement of scope.source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  return null;
}

/** Every `app.register(...)` call in the graph — the legacy registration shape. */
function findAppRegisterCalls(
  ts: TsModule,
  scopes: ModuleScope[],
): Array<{ node: TsNode; scope: ModuleScope }> {
  const out: Array<{ node: TsNode; scope: ModuleScope }> = [];
  for (const scope of scopes) {
    const visit = (node: TsNode): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register'
      ) {
        const receiver = node.expression.expression;
        const isApp =
          (ts.isIdentifier(receiver) && receiver.text === 'app') ||
          (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'app');
        if (isApp) out.push({ node, scope });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope.source, visit);
  }
  return out;
}

/**
 * Find the app's `defineApp({...})` registration.
 *
 * Unlike `findRegisterCall` there is nothing to guess at: the shape is pinned,
 * so the config argument of the one `defineApp` call — reached from the entry
 * module's default export — *is* the protocol. Everything else is refused with
 * a location rather than resolved by heuristic.
 *
 * Returns null with no error when this app does not use `defineApp` at all;
 * callers must check `extractor.errors` to tell that apart from a rejection.
 */
function findDefineAppCall(
  ts: TsModule,
  scopes: ModuleScope[],
  extractor: Extractor,
): { args: TsExpression; scope: ModuleScope } | null {
  const calls: Array<{ call: import('typescript').CallExpression; scope: ModuleScope }> = [];
  for (const scope of scopes) {
    const visit = (node: TsNode): void => {
      if (isDefineAppCall(ts, node, scope)) {
        calls.push({ call: node as import('typescript').CallExpression, scope });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope.source, visit);
  }
  if (calls.length === 0) return null;

  // Two calls is two registrations. The runtime now throws on the second one
  // (an authoritative registration cannot be replaced), so shipping a manifest
  // built from either would describe an app the iframe refuses to run.
  if (calls.length > 1) {
    extractor.error(
      calls[1].scope,
      calls[1].call,
      `found ${calls.length} \`defineApp({...})\` calls; a window hosts exactly one app, ` +
        `so keep a single \`export default defineApp({...})\``,
    );
    return null;
  }

  const site = calls[0];
  // The default export is the anchor: it is what the proposal pins, and it is
  // the only spelling under which registration timing is the SDK's to own.
  const entry = scopes[0];
  const exported = defaultExportExpression(ts, entry);
  const resolved = exported ? extractor.unwrap(exported, entry).node : null;
  if (resolved !== site.call) {
    extractor.error(
      site.scope,
      site.call,
      "`defineApp()`: its result must be the default export of the app's entry module " +
        '(`export default defineApp({...})` in src/main.ts)',
    );
    return null;
  }

  if (site.call.arguments.length !== 1 || ts.isSpreadElement(site.call.arguments[0])) {
    extractor.error(
      site.scope,
      site.call,
      '`defineApp()`: expected exactly one argument, an object literal describing the app',
    );
    return null;
  }

  return { args: site.call.arguments[0], scope: site.scope };
}

/**
 * Copy an optional JSON-object property (`params`/`returns`/`schema`) onto a
 * descriptor.
 *
 * `foldable` turns the failure into a deferral: `z.object({...})` is a builder
 * chain, not a constant, so a static evaluator can only ever report it as
 * unresolvable. Rather than teach this evaluator Zod's API, the path is recorded
 * and `fold-schemas.ts` reads the schema off the app it runs. The refusal
 * property is unchanged — the fold either produces the schema or the build fails
 * naming this same path.
 */
function assignObject(
  extractor: Extractor,
  target: Record<string, unknown>,
  key: string,
  source: Map<string, { value: TsNode; scope: ModuleScope }>,
  label: string,
  foldable = false,
): boolean {
  const entry = source.get(key);
  if (!entry) return true;
  const mark = extractor.errors.length;
  const value = extractor.evaluate(entry.value, entry.scope, `${label}.${key}`);
  if (value === undefined) {
    if (!foldable) return false;
    extractor.rollbackErrors(mark);
    extractor.pendingFolds.push(`${label}.${key}`);
    return true;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    extractor.error(entry.scope, entry.value, `\`${label}.${key}\`: expected an object`);
    return false;
  }
  target[key] = value;
  return true;
}

/**
 * Reject two commands reachable by the same name.
 *
 * At runtime the SDK builds one flat alias map and the last registration wins, so
 * a duplicate does not fail — it makes one command silently unreachable. The
 * manifest still advertises both, so the agent calls a name that answers with the
 * wrong handler. Names and aliases share the lookup, which is why a name
 * colliding with another command's alias is the same defect.
 */
function checkAliasCollisions(
  extractor: Extractor,
  entries: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
  commands: Protocol['commands'],
): void {
  const owners = new Map<string, { command: string; kind: 'name' | 'alias' }>();
  const byKey = new Map(entries.map((e) => [e.key, e]));

  const claim = (spelling: string, command: string, kind: 'name' | 'alias'): void => {
    const held = owners.get(spelling);
    if (!held) {
      owners.set(spelling, { command, kind });
      return;
    }
    const site = byKey.get(command);
    if (!site) return;
    const taken =
      held.kind === 'name' ? `command \`${held.command}\`` : `an alias of \`${held.command}\``;
    const mine = kind === 'name' ? 'a command name' : `an alias of \`${command}\``;
    extractor.error(
      site.scope,
      site.value,
      `\`commands.${command}\`: \`${spelling}\` is already ${taken} and is also ${mine}; ` +
        `one name resolves to one command at runtime, so the other becomes unreachable`,
    );
  };

  for (const name of Object.keys(commands)) claim(name, name, 'name');
  for (const [name, descriptor] of Object.entries(commands)) {
    for (const alias of descriptor.aliases ?? []) claim(alias, name, 'alias');
  }
}

/** How a registration shape names the thing that answers a query or a command. */
interface ImplKeys {
  /** Property carrying the state getter — `handler` (register) or `get` (defineApp). */
  state: string;
  /** Property carrying the command handler — `handler` (register) or `run` (defineApp). */
  commands: string;
}

interface BuildOptions {
  /** Method shorthand is legal in this config shape. */
  allowMethods: boolean;
  /**
   * A `params`/`returns`/`schema` that is not a constant may be a Zod schema and
   * is deferred to the runtime fold instead of erroring. Only `defineApp` sets
   * it — see `assignObject`.
   */
  foldable?: boolean;
  /**
   * Require each descriptor to carry its implementation, and under which name.
   * Only `defineApp` sets it: its shape is pinned, so a descriptor missing `run`
   * is a typo the build can name, not an authoring style.
   */
  requireImpl?: ImplKeys;
}

/**
 * Turn a flattened registration config into the manifest.
 *
 * Shared by `app.register({...})` and `defineApp({...})`: the two differ in how
 * the registration is *located* and in what the handler property is called, not
 * in how descriptors are read. Spreads, `const` refs, and identity wrappers
 * resolve identically for both, and anything unresolvable is an error either
 * way.
 */
function buildProtocol(
  ts: TsModule,
  extractor: Extractor,
  config: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
  options: BuildOptions,
): Protocol {
  const sections = new Map(config.map((e) => [e.key, e]));
  const protocol: Protocol = { state: {}, commands: {} };

  /** Resolve a top-level section (`state`/`commands`/`events`) to its entries. */
  const sectionEntries = (
    name: 'state' | 'commands' | 'events',
  ): Array<{ key: string; value: TsNode; scope: ModuleScope }> | null => {
    const section = sections.get(name);
    if (!section) return [];
    const { node, scope } = extractor.unwrap(section.value, section.scope);
    if (!ts.isObjectLiteralExpression(node)) {
      extractor.error(
        section.scope,
        section.value,
        `\`${name}\`: could not be resolved to an object literal ` +
          `(${extractor.describeNode(node)})`,
      );
      return null;
    }
    return extractor.flattenObject(node, scope, name, 0, options.allowMethods);
  };

  /** Resolve one descriptor to its own property map. */
  const descriptorProps = (
    entry: { key: string; value: TsNode; scope: ModuleScope },
    label: string,
  ): Map<string, { value: TsNode; scope: ModuleScope }> | null => {
    const { node, scope } = extractor.unwrap(entry.value, entry.scope);
    if (!ts.isObjectLiteralExpression(node)) {
      extractor.error(
        entry.scope,
        entry.value,
        `\`${label}\`: descriptor could not be resolved to an object literal ` +
          `(${extractor.describeNode(node)})`,
      );
      return null;
    }
    const props = extractor.flattenObject(node, scope, label, 0, options.allowMethods);
    if (props === null) return null;
    return new Map(props.map((p) => [p.key, { value: p.value, scope: p.scope }]));
  };

  /**
   * A manifest entry whose implementation is missing answers nothing at
   * runtime, so it is a command in name only.
   */
  const hasImpl = (
    props: Map<string, { value: TsNode; scope: ModuleScope }>,
    entry: { value: TsNode; scope: ModuleScope },
    label: string,
    kind: keyof ImplKeys,
  ): boolean => {
    if (!options.requireImpl) return true;
    const key = options.requireImpl[kind];
    if (props.has(key)) return true;
    extractor.error(
      entry.scope,
      entry.value,
      `\`${label}\`: missing \`${key}\`; an entry the app cannot ` +
        `${kind === 'state' ? 'read' : 'run'} is not a capability`,
    );
    return false;
  };

  /** Every descriptor needs a description — it is what the agent reads. */
  const readDescription = (
    props: Map<string, { value: TsNode; scope: ModuleScope }>,
    entry: { value: TsNode; scope: ModuleScope },
    label: string,
  ): string | null => {
    const prop = props.get('description');
    if (!prop) {
      extractor.error(
        entry.scope,
        entry.value,
        `\`${label}\`: missing \`description\`; an entry without one is invisible to agents`,
      );
      return null;
    }
    const value = extractor.evaluate(prop.value, prop.scope, `${label}.description`);
    if (value === undefined) return null;
    if (typeof value !== 'string') {
      extractor.error(prop.scope, prop.value, `\`${label}.description\`: expected a string`);
      return null;
    }
    return value;
  };

  // -- state ---------------------------------------------------------------
  const stateEntries = sectionEntries('state');
  if (stateEntries) {
    for (const entry of stateEntries) {
      if (entry.key === 'manifest') continue; // built-in, served by the SDK
      const label = `state.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      if (!hasImpl(props, entry, label, 'state')) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      const descriptor: Record<string, unknown> = { description };
      if (!assignObject(extractor, descriptor, 'schema', props, label, options.foldable)) continue;
      protocol.state[entry.key] = descriptor as { description: string; schema?: object };
    }
  }

  // -- commands ------------------------------------------------------------
  const commandEntries = sectionEntries('commands');
  if (commandEntries) {
    for (const entry of commandEntries) {
      const label = `commands.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      if (!hasImpl(props, entry, label, 'commands')) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      const descriptor: Record<string, unknown> = { description };

      const aliasProp = props.get('aliases');
      if (aliasProp) {
        const aliases = extractor.evaluate(aliasProp.value, aliasProp.scope, `${label}.aliases`);
        if (aliases === undefined) continue;
        if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string')) {
          extractor.error(
            aliasProp.scope,
            aliasProp.value,
            `\`${label}.aliases\`: expected an array of strings`,
          );
          continue;
        }
        descriptor.aliases = aliases;
      }

      // The replay policy has to reach the manifest, not just the runtime: the
      // server reads it to decide whether a remounted iframe gets this command
      // re-sent. A descriptor that says `replay: 'never'` while the manifest
      // says nothing is a command that double-applies on every remount.
      const replayProp = props.get('replay');
      if (replayProp) {
        const replay = extractor.evaluate(replayProp.value, replayProp.scope, `${label}.replay`);
        if (replay === undefined) continue;
        if (replay !== 'always' && replay !== 'never') {
          extractor.error(
            replayProp.scope,
            replayProp.value,
            `\`${label}.replay\`: expected 'always' or 'never'`,
          );
          continue;
        }
        descriptor.replay = replay;
      }

      if (!assignObject(extractor, descriptor, 'params', props, label, options.foldable)) continue;
      if (!assignObject(extractor, descriptor, 'returns', props, label, options.foldable)) continue;
      protocol.commands[entry.key] = descriptor as {
        description: string;
        aliases?: string[];
        params?: object;
        returns?: object;
      };
    }
    checkAliasCollisions(extractor, commandEntries, protocol.commands);
  }

  // -- events --------------------------------------------------------------
  const eventEntries = sectionEntries('events');
  if (eventEntries && eventEntries.length > 0) {
    const events: NonNullable<Protocol['events']> = {};
    for (const entry of eventEntries) {
      const label = `events.${entry.key}`;
      const props = descriptorProps(entry, label);
      if (!props) continue;
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      events[entry.key] = { description };
    }
    if (Object.keys(events).length > 0) protocol.events = events;
  }

  return protocol;
}

/** An extracted protocol, or null when nothing was declared. */
function finish(
  extractor: Extractor,
  protocol: Protocol | null,
  usesDefineApp = false,
): AstProtocolExtraction {
  const rest = { pendingFolds: extractor.pendingFolds, usesDefineApp };
  if (extractor.errors.length > 0) return { protocol: null, errors: extractor.errors, ...rest };
  if (!protocol) return { protocol: null, errors: [], ...rest };
  const empty =
    Object.keys(protocol.state).length === 0 &&
    Object.keys(protocol.commands).length === 0 &&
    !protocol.events;
  return { protocol: empty ? null : protocol, errors: [], ...rest };
}

export interface ExtractOptions {
  /**
   * The app's `app.json` `appId`, when it is known. `defineApp`'s `id` must
   * equal it, since the id is what the runtime registers under and what every
   * agent-facing route keys on. Undefined skips the check — a bare sandbox has
   * no app.json to compare against, and refusing to build there would block
   * exactly the scratch compiles the sandbox exists for.
   */
  appId?: string;
}

/**
 * Extract the app protocol manifest starting from `entry`, following relative
 * imports. `readFile` must return null for paths that do not exist.
 *
 * Two registration shapes are recognized, in order:
 *
 *  - `export default defineApp({...})` — the config object *is* the protocol,
 *    located rather than guessed at;
 *  - `app.register({...})` — the legacy shape, located by `findRegisterCall`'s
 *    receiver rule and ambiguity handling.
 *
 * An app that does both is refused: two registrations means the manifest can
 * only describe one of them, and which one the iframe ends up running is not
 * something this file can see.
 *
 * `protocol` is null only when no registration was found at all. When `errors`
 * is non-empty the caller must fail the build: a manifest that parsed around an
 * unresolvable descriptor is a manifest missing commands.
 */
export function extractProtocolFromModules(
  ts: TsModule,
  entry: string,
  readFile: ReadFile,
  options: ExtractOptions = {},
): AstProtocolExtraction {
  const extractor = new Extractor(ts, readFile);
  /** Every early exit carries the same shape as `finish()`. */
  const bail = (usesDefineApp = false): AstProtocolExtraction => ({
    protocol: null,
    errors: extractor.errors,
    pendingFolds: extractor.pendingFolds,
    usesDefineApp,
  });

  const scopes = extractor.moduleGraph(entry);
  // Errors already recorded (an unparseable file) must survive these early
  // exits — a module that failed to parse is exactly the case where "no
  // register() found" is the wrong conclusion to report silently.
  if (scopes.length === 0) return bail();

  // Mutual exclusion. Both calls register, the runtime lets exactly one win,
  // and nothing here can tell which — so the manifest would describe an app the
  // iframe may not be running. Keyed on the import rather than on a resolved
  // call so an app mid-migration is caught before the shapes interleave.
  const usesDefineApp = importsDefineApp(scopes);
  if (usesDefineApp) {
    const registers = findAppRegisterCalls(ts, scopes);
    if (registers.length > 0) {
      extractor.error(
        registers[0].scope,
        registers[0].node,
        'this app imports `defineApp` and also calls `app.register({...})`; both register ' +
          'the app and only one can win at runtime, so the manifest cannot describe either ' +
          'with confidence. Keep the `defineApp` default export and delete the ' +
          '`app.register({...})` call',
      );
      return bail(true);
    }
  }

  const errorsBefore = extractor.errors.length;
  const defineApp = findDefineAppCall(ts, scopes, extractor);
  // A `defineApp` that was found and rejected must not fall through to the
  // legacy search: that would hide the very failure the errors describe.
  if (extractor.errors.length > errorsBefore) return bail(true);
  if (defineApp) {
    return finish(extractor, extractDefineApp(ts, extractor, defineApp, options), true);
  }

  const call = findRegisterCall(ts, scopes, extractor);
  if (!call) return bail(usesDefineApp);

  const { node: configNode, scope: configScope } = extractor.unwrap(call.args, call.scope);
  if (!ts.isObjectLiteralExpression(configNode)) {
    extractor.error(
      call.scope,
      call.args,
      `\`register()\`: argument could not be resolved to an object literal ` +
        `(${extractor.describeNode(configNode)})`,
    );
    return bail();
  }

  const config = extractor.flattenObject(configNode, configScope, 'register');
  if (config === null) return bail();

  return finish(extractor, buildProtocol(ts, extractor, config, { allowMethods: false }));
}

/** Read the protocol out of a located `defineApp({...})` config. */
function extractDefineApp(
  ts: TsModule,
  extractor: Extractor,
  site: { args: TsExpression; scope: ModuleScope },
  options: ExtractOptions,
): Protocol | null {
  const { node: configNode, scope: configScope } = extractor.unwrap(site.args, site.scope);
  if (!ts.isObjectLiteralExpression(configNode)) {
    extractor.error(
      site.scope,
      site.args,
      `\`defineApp()\`: argument could not be resolved to an object literal ` +
        `(${extractor.describeNode(configNode)})`,
    );
    return null;
  }

  const config = extractor.flattenObject(configNode, configScope, 'defineApp', 0, true);
  if (config === null) return null;

  checkAppId(extractor, config, site, options.appId);

  return buildProtocol(ts, extractor, config, {
    allowMethods: true,
    requireImpl: { state: 'get', commands: 'run' },
    // Only here: the config is reachable at runtime as the entry module's
    // default export, which is what makes reading a Zod schema back out of the
    // running app possible at all.
    foldable: true,
  });
}

/**
 * `defineApp`'s `id` must be the app's own id.
 *
 * It is what the runtime registers under, what `protocol.json` is filed against,
 * and what every agent-facing route keys on. A mismatch does not fail anything
 * loudly — it produces a window whose manifest is filed under a name nothing
 * else uses.
 */
function checkAppId(
  extractor: Extractor,
  config: Array<{ key: string; value: TsNode; scope: ModuleScope }>,
  site: { args: TsExpression; scope: ModuleScope },
  expected: string | undefined,
): void {
  const entry = config.find((e) => e.key === 'id');
  if (!entry) {
    extractor.error(
      site.scope,
      site.args,
      "`defineApp()`: missing `id`; it must equal the `appId` in this app's app.json",
    );
    return;
  }
  const id = extractor.evaluate(entry.value, entry.scope, 'defineApp.id');
  if (id === undefined) return;
  if (typeof id !== 'string' || id === '') {
    extractor.error(entry.scope, entry.value, '`defineApp.id`: expected a non-empty string');
    return;
  }
  if (expected !== undefined && id !== expected) {
    extractor.error(
      entry.scope,
      entry.value,
      `\`defineApp.id\`: declared \`${id}\` but this app's app.json says \`${expected}\`; ` +
        `the id is what the app registers under, so the two must agree`,
    );
  }
}
