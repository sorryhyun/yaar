/**
 * Parse an app source file the way every runtime-contract guard needs it.
 *
 * Neither argument is incidental: the scanners call `getText`/`getStart`, which
 * need parent pointers (`setParentNodes: true`), and an app source may be `.tsx`.
 * Sharing one call is also what lets a caller parse *once* and hand the same tree
 * to each guard — the bundler's `onLoad` runs two scanners over identical text.
 */

type TsModule = typeof import('typescript');

export function createAppSourceFile(
  ts: TsModule,
  fileName: string,
  source: string,
): import('typescript').SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
