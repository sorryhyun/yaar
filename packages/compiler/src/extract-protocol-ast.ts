/**
 * Extract App Protocol manifest from TypeScript source using the TypeScript AST.
 *
 * This replaces the brace-matching text scanner in `extract-protocol.ts` for every
 * build where the `typescript` module is loadable. The difference that matters is
 * not accuracy on the shapes the old scanner already handled — it is *reach*:
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

  constructor(
    private readonly ts: TsModule,
    private readonly readFile: ReadFile,
  ) {}

  // -- diagnostics ---------------------------------------------------------

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
    // deliberately does not follow. Only the SDK's documented identity helper
    // (`shims/yaar/ui.ts`) is trusted by name.
    return callee.text === 'defineCommand';
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
   */
  flattenObject(
    literal: TsObjectLiteral,
    scope: ModuleScope,
    label: string,
    depth = 0,
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
        const nested = this.flattenObject(target, targetScope, label, depth + 1);
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

/** Copy an optional JSON-object property onto a descriptor. */
function assignObject(
  extractor: Extractor,
  target: Record<string, unknown>,
  key: string,
  source: Map<string, { value: TsNode; scope: ModuleScope }>,
  label: string,
): boolean {
  const entry = source.get(key);
  if (!entry) return true;
  const value = extractor.evaluate(entry.value, entry.scope, `${label}.${key}`);
  if (value === undefined) return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    extractor.error(entry.scope, entry.value, `\`${label}.${key}\`: expected an object`);
    return false;
  }
  target[key] = value;
  return true;
}

/**
 * Extract the app protocol manifest starting from `entry`, following relative
 * imports. `readFile` must return null for paths that do not exist.
 *
 * `protocol` is null only when no `register()` call was found at all. When
 * `errors` is non-empty the caller must fail the build: a manifest that parsed
 * around an unresolvable descriptor is a manifest missing commands.
 */
export function extractProtocolFromModules(
  ts: TsModule,
  entry: string,
  readFile: ReadFile,
): AstProtocolExtraction {
  const extractor = new Extractor(ts, readFile);
  const scopes = extractor.moduleGraph(entry);
  // Errors already recorded (an unparseable file) must survive these early
  // exits — a module that failed to parse is exactly the case where "no
  // register() found" is the wrong conclusion to report silently.
  if (scopes.length === 0) return { protocol: null, errors: extractor.errors };

  const call = findRegisterCall(ts, scopes, extractor);
  if (!call) return { protocol: null, errors: extractor.errors };

  const { node: configNode, scope: configScope } = extractor.unwrap(call.args, call.scope);
  if (!ts.isObjectLiteralExpression(configNode)) {
    extractor.error(
      call.scope,
      call.args,
      `\`register()\`: argument could not be resolved to an object literal ` +
        `(${extractor.describeNode(configNode)})`,
    );
    return { protocol: null, errors: extractor.errors };
  }

  const config = extractor.flattenObject(configNode, configScope, 'register');
  if (config === null) return { protocol: null, errors: extractor.errors };

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
    return extractor.flattenObject(node, scope, name);
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
    const props = extractor.flattenObject(node, scope, label);
    if (props === null) return null;
    return new Map(props.map((p) => [p.key, { value: p.value, scope: p.scope }]));
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
      const description = readDescription(props, entry, label);
      if (description === null) continue;
      const descriptor: Record<string, unknown> = { description };
      if (!assignObject(extractor, descriptor, 'schema', props, label)) continue;
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

      if (!assignObject(extractor, descriptor, 'params', props, label)) continue;
      if (!assignObject(extractor, descriptor, 'returns', props, label)) continue;
      protocol.commands[entry.key] = descriptor as {
        description: string;
        aliases?: string[];
        params?: object;
        returns?: object;
      };
    }
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

  if (extractor.errors.length > 0) return { protocol: null, errors: extractor.errors };

  const empty =
    Object.keys(protocol.state).length === 0 &&
    Object.keys(protocol.commands).length === 0 &&
    !protocol.events;
  return { protocol: empty ? null : protocol, errors: [] };
}
