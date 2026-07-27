/**
 * The reader: resolve a name, unwrap a value, flatten an object literal.
 *
 * Everything here is about turning source into constants, and it knows nothing
 * about `defineApp` — `extract-protocol-ast.ts` is what asks it for a `commands`
 * block. The split is deliberate: this class is the correctness-critical part,
 * and it is fully parameterized by `(ts, readFile)`, so it can be exercised
 * against any module set.
 *
 * The invariant it exists to hold: **an entry that works at runtime must be
 * visible in the static manifest.** Anything it cannot resolve is recorded as a
 * hard error with a source location, never dropped. A partial result is never
 * returned — a half-read `commands` block is exactly the silent truncation this
 * subsystem exists to prevent.
 */

import {
  buildScope,
  isRelative,
  resolveModulePath,
  MAX_MODULE_DEPTH,
  type Binding,
  type ModuleScope,
  type ProtocolError,
  type ReadFile,
  type TsModule,
  type TsNode,
  type TsObjectLiteral,
} from './protocol-module-graph.js';

/** Recursion ceiling when folding a value. A JSON Schema nests a few levels. */
const MAX_VALUE_DEPTH = 100;

export class Extractor {
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
   * Two things qualify. `defineAppCommand` is the SDK's declared identity helper
   * (`shims/yaar/ui.ts`), which apps import from a package the extractor
   * deliberately will not follow. Anything else must resolve, inside this app,
   * to a literal identity function.
   */
  isTransparentWrapper(callee: import('typescript').Identifier, scope: ModuleScope): boolean {
    // Anything this app declares must prove itself, whatever it is named. The
    // name check below is trusted only for a callee that resolves to nothing
    // here — i.e. one that came from a package. Trusting the bare name first
    // would let a locally-declared `function defineAppCommand` that decorates
    // its argument pass unexamined, which is the exact hole this method closes
    // for every other name.
    const bound = this.resolveIdentifier(callee, scope);
    if (bound === 'shadowed') return false;
    if (bound) return this.isIdentityFunction(bound.node);

    // Undeclared in the app, so it is imported from a package the extractor
    // deliberately does not follow. Only the SDK's documented identity helper
    // (`shims/yaar/ui.ts`) is trusted by name.
    return callee.text === 'defineAppCommand';
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
   * `satisfies`, non-null `!`, and identity calls such as `defineAppCommand({...})`.
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
   * A method shorthand is recorded as an entry rather than rejected:
   * `onClose() {...}` and `run(p) {...}` are ordinary ways to write a lifecycle
   * hook and a handler in a `defineApp` config, and neither is a value the
   * manifest reads.
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
        const key = this.propertyKey(prop.name, scope, label);
        if (key === null) {
          failed = true;
          continue;
        }
        entries.push({ key, value: prop, scope });
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
