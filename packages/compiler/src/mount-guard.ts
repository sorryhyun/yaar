/**
 * Static guard for the app mount point.
 *
 * The compiler emits exactly one element for an app to render into:
 * `<div id="app">` (see `generateHtmlWrapper`). Rendering into any other id is a
 * guaranteed dead app — `getElementById` returns `null`, the mount is skipped or
 * throws, and because the wrapper also carries `#app:empty{display:none}` the
 * window renders *nothing at all* rather than something visibly broken.
 *
 * Nothing else catches this. `document.getElementById('root')!` is perfectly
 * well-typed, so `tsc` is green; the bundle builds, so the compiler is green.
 * The first signal is a protocol query timing out, long after deploy.
 *
 * The check is scoped to the *render target* specifically — the second argument
 * of `render(...)` — and not to element lookups in general, because apps
 * legitimately look up ids in markup they rendered themselves (`#canvas`) or in
 * DOM trees they parsed (`DOMParser` documents). Only a literal
 * `document.getElementById('x')` / `document.querySelector('#x')` reaching the
 * render target is flagged; a computed target is left alone.
 */

import { createAppSourceFile } from './ts-source.js';

/** The id of the mount element `generateHtmlWrapper` emits. The single source of truth. */
export const APP_MOUNT_ID = 'app';

/** Minimal structural view of the `typescript` module this scanner needs. */
type TsModule = typeof import('typescript');
type TsNode = import('typescript').Node;
type TsExpression = import('typescript').Expression;
type TsSourceFile = import('typescript').SourceFile;

export interface MountFinding {
  line: number;
  column: number;
  /** The id the app tried to mount into. */
  id: string;
  /** How the id was written, e.g. `getElementById('root')`. */
  snippet: string;
}

/** Strip `!`, `as T`, and parens to reach the underlying expression. */
function unwrap(ts: TsModule, node: TsExpression): TsExpression {
  let current = node;
  for (;;) {
    if (
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * If `expr` is a literal lookup on the global `document`, return the id it asks
 * for. Returns null for computed lookups and for lookups on any other object —
 * a `DOMParser` document is not the page.
 */
function lookupId(ts: TsModule, expr: TsExpression, sf: TsSourceFile): string | null {
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.expression.getText(sf) !== 'document') return null;

  const arg = expr.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return null;

  const method = callee.name.text;
  if (method === 'getElementById') return arg.text;
  // Only an id selector is a mount point we can reason about; `.class`/`div` are not.
  if (method === 'querySelector' && /^#[\w-]+$/.test(arg.text)) return arg.text.slice(1);
  return null;
}

/**
 * Resolve a render target to the id it looks up, following one level of
 * variable indirection: `const el = document.getElementById('root'); render(f, el)`
 * is the same defect as the inline form, and is how it usually gets written.
 */
function resolveTargetId(ts: TsModule, target: TsExpression, sf: TsSourceFile): string | null {
  const expr = unwrap(ts, target);

  const direct = lookupId(ts, expr, sf);
  if (direct !== null) return direct;

  if (!ts.isIdentifier(expr)) return null;
  const name = expr.text;

  let found: string | null = null;
  const visit = (node: TsNode): void => {
    if (
      found === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = lookupId(ts, unwrap(ts, node.initializer), sf);
    }
    if (found === null) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Walk an already-parsed source file for `render(component, target)` calls whose
 * target is a literal lookup of an element the compiler never emits.
 *
 * Takes a `SourceFile` rather than text so the bundler plugin, which runs this
 * and the solid-html guard over the same file, pays for one parse instead of two.
 */
export function scanMountTargetsIn(ts: TsModule, sf: TsSourceFile): MountFinding[] {
  const findings: MountFinding[] = [];

  const visit = (node: TsNode): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'render' &&
      node.arguments.length >= 2
    ) {
      const target = node.arguments[1];
      const id = resolveTargetId(ts, target, sf);
      if (id !== null && id !== APP_MOUNT_ID) {
        const { line, character } = sf.getLineAndCharacterOfPosition(target.getStart(sf));
        findings.push({
          line: line + 1,
          column: character + 1,
          id,
          snippet: target.getText(sf).replace(/\s+/g, ' ').slice(0, 72),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

/** Parse `source` and scan it. */
export function scanMountTargets(ts: TsModule, source: string, fileName: string): MountFinding[] {
  return scanMountTargetsIn(ts, createAppSourceFile(ts, fileName, source));
}

/**
 * Render findings as a compile error body.
 *
 * ASCII only: this message reaches the user through Bun's plugin error path,
 * which mangles non-ASCII bytes (an em dash arrives as `â`).
 */
export function formatMountFindings(fileName: string, findings: MountFinding[]): string {
  const lines = findings.map(
    (f) =>
      `${fileName}:${f.line}:${f.column}: ${f.snippet}\n` +
      `  problem: there is no #${f.id} element. The compiler renders exactly one mount point, ` +
      `#${APP_MOUNT_ID}, so this lookup returns null and the app mounts nothing.\n` +
      `  fix:     render(App, document.getElementById('${APP_MOUNT_ID}')!)`,
  );
  const n = findings.length;
  return `app mount point: ${n} bad render target${n === 1 ? '' : 's'}\n\n${lines.join('\n\n')}`;
}
