/**
 * The shape every runtime-contract guard has in common: parse, walk, quote the
 * offending source, and report it.
 *
 * The guards themselves are the interesting part — what counts as a broken
 * `html` template or a dead mount point. The machinery around them was written
 * twice, identically, down to the two-space `problem:` / `fix:` indent. Two
 * things in particular must not drift:
 *
 * - **One parse per file.** The bundler's `onLoad` hands the same source to both
 *   scanners; `createAppSourceFile` is what lets it pay for one `SourceFile`.
 * - **ASCII only.** A guard message raised from a Bun plugin passes through an
 *   error path that mangles non-ASCII bytes (an em dash arrives as `â`), so the
 *   rendered report has to stay in ASCII. That rule now has one home instead of
 *   two comments, and `guard-report.test.ts` asserts it.
 */

type TsModule = typeof import('typescript');
type TsNode = import('typescript').Node;
type TsSourceFile = import('typescript').SourceFile;

/**
 * Parse an app source file the way every guard needs it.
 *
 * Neither argument is incidental: the scanners call `getText`/`getStart`, which
 * need parent pointers (`setParentNodes: true`), and an app source may be `.tsx`.
 */
export function createAppSourceFile(ts: TsModule, fileName: string, source: string): TsSourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Visit every node under `root`, depth-first. */
export function walk(ts: TsModule, root: TsNode, visit: (node: TsNode) => void): void {
  const step = (node: TsNode): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  step(root);
}

/**
 * The first non-null result of `probe` over the tree, or null.
 *
 * A probe that returns null is indistinguishable from "no match", which is what
 * a caller resolving a name through the file wants: keep looking.
 */
export function findFirst<T>(
  ts: TsModule,
  root: TsNode,
  probe: (node: TsNode) => T | null,
): T | null {
  let found: T | null = null;
  const step = (node: TsNode): void => {
    if (found !== null) return;
    found = probe(node);
    if (found === null) ts.forEachChild(node, step);
  };
  step(root);
  return found;
}

/** How much source a finding quotes back — one line's worth, whitespace collapsed. */
const SNIPPET_LENGTH = 72;

/** The offending source, collapsed to a single short line. */
export function snippetOf(node: TsNode, sf: TsSourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').slice(0, SNIPPET_LENGTH);
}

/** 1-indexed line/column of a node's start, as an error message spells it. */
export function positionOf(node: TsNode, sf: TsSourceFile): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

/** What a report calls itself, and what it counts. */
export interface GuardLabel {
  /** The subsystem, e.g. `solid-js/html`. */
  label: string;
  /** Singular noun for one finding, e.g. `broken template`. Pluralized with `s`. */
  noun: string;
}

/** `solid-js/html: 2 broken templates` — the first line of every guard report. */
export function guardHeadline({ label, noun }: GuardLabel, count: number): string {
  return `${label}: ${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One reported defect, already reduced to the words the author reads. */
export interface GuardEntry {
  line: number;
  column: number;
  snippet: string;
  /** What goes wrong at runtime. */
  problem: string;
  /** What the author should write instead. */
  fix: string;
}

/**
 * Render findings from one file as a compile error body.
 *
 * Keep the output ASCII — see the module header.
 */
export function formatGuardFindings(
  fileName: string,
  label: GuardLabel,
  entries: GuardEntry[],
): string {
  const blocks = entries.map(
    (e) =>
      `${fileName}:${e.line}:${e.column}: ${e.snippet}\n` +
      `  problem: ${e.problem}\n` +
      `  fix:     ${e.fix}`,
  );
  return `${guardHeadline(label, entries.length)}\n\n${blocks.join('\n\n')}`;
}
