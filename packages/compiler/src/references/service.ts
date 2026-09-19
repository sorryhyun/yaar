/**
 * Find references and callers in an app sandbox, with the checker's own answer.
 *
 * A grep finds a name; this finds a *symbol* — through `export { x } from`
 * re-exports, renamed imports, a method called on an instance whose class was
 * imported under another name, and members declared in `@bundled/*`. That last
 * one is why it runs on the server: the program is built from the same compiler
 * options and the same grant-sliced declarations `typecheckSandbox` uses
 * (`sandbox-tsconfig.ts`), so a symbol the typecheck resolves is one this resolves.
 *
 * Synchronous and CPU-heavy (a cold program over a 20k-line app takes seconds), so
 * it is only ever run inside the worker in `worker.ts`, never on the server thread.
 * One service per sandbox is kept warm there; file versions are mtimes, so an edit
 * between two queries is re-read and nothing else is.
 */

import { readFileSync, statSync } from 'fs';
import { isAbsolute, join, normalize, relative, resolve } from 'path';
import type TS from 'typescript';
import { BUNDLED_TYPES_DTS, PACKAGE_ROOT } from '../paths.js';
import { SANDBOX_INCLUDE, sandboxCompilerOptions, sliceBundledTypes } from '../sandbox-tsconfig.js';
import type { ThreeRenderer } from '../bundled/three-renderer.js';
import type {
  CallerHit,
  FindReferencesQuery,
  FindReferencesResult,
  ReferenceDefinition,
  ReferenceHit,
  SourceLocation,
} from './types.js';

export const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS_CEILING = 2_000;
const TEXT_CLIP = 200;
const TOP_LEVEL = '(top level)';

/**
 * Where the grant-sliced declarations live. Never written: the host serves it from
 * memory. It sits under the compiler package so the re-exports inside resolve
 * against the compiler's node_modules, as the typecheck's temporary copy does.
 */
const SLICED_TYPES_PATH = join(PACKAGE_ROOT, '.yaar-bundled-types.references.d.ts');

const fwd = (p: string): string => p.replace(/\\/g, '/');

function mtimeVersion(file: string): string {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return '0';
  }
}

export class SandboxReferences {
  private readonly root: string;
  private readonly options: TS.CompilerOptions;
  private readonly service: TS.LanguageService;
  private typesFile = BUNDLED_TYPES_DTS;
  private slicedText: string | null = null;
  private slicedFrom = '';
  private fileNames: string[] = [];

  constructor(
    private readonly ts: typeof TS,
    sandboxRoot: string,
    private readonly bundles: string[],
    private readonly three: ThreeRenderer,
  ) {
    this.root = fwd(resolve(sandboxRoot));
    this.options = ts.convertCompilerOptionsFromJson(
      sandboxCompilerOptions(bundles, three),
      this.root,
    ).options;

    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: (f) => (f === SLICED_TYPES_PATH ? this.slicedFrom : mtimeVersion(f)),
      getScriptSnapshot: (f) => {
        const text = this.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => f === SLICED_TYPES_PATH || ts.sys.fileExists(f),
      readFile: (f) => this.readFile(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  dispose(): void {
    this.service.dispose();
  }

  private readFile(f: string): string | undefined {
    if (f === SLICED_TYPES_PATH) return this.slicedText ?? '';
    return this.ts.sys.readFile(f);
  }

  /** Re-list the sources and re-slice the declarations if either could have moved. */
  private refresh(): void {
    const typesVersion = mtimeVersion(BUNDLED_TYPES_DTS);
    if (typesVersion !== this.slicedFrom) {
      const sliced = sliceBundledTypes(
        this.ts,
        readFileSync(BUNDLED_TYPES_DTS, 'utf8'),
        this.bundles,
        this.three,
      );
      this.slicedText = sliced;
      this.slicedFrom = typesVersion;
      this.typesFile = sliced === null ? BUNDLED_TYPES_DTS : SLICED_TYPES_PATH;
    }
    const sources = this.ts.sys
      .readDirectory(this.root, ['.ts'], undefined, SANDBOX_INCLUDE)
      .map(fwd);
    this.fileNames = [this.typesFile, ...sources];
  }

  find(query: FindReferencesQuery): FindReferencesResult {
    const { ts } = this;
    this.refresh();

    const relFile = fwd(normalize(query.file)).replace(/^\.\//, '');
    if (isAbsolute(relFile) || relFile.startsWith('../')) {
      return {
        success: false,
        kind: 'invalid',
        error: `"file" must be sandbox-relative: ${query.file}`,
      };
    }
    const absFile = `${this.root}/${relFile}`;
    const program = this.service.getProgram();
    const sourceFile = program?.getSourceFile(absFile);
    if (!program || !sourceFile) {
      return {
        success: false,
        kind: 'not-found',
        error: `${relFile} is not in the project (sources are ${SANDBOX_INCLUDE.join(', ')})`,
      };
    }

    const resolved = this.resolvePosition(sourceFile, query);
    if ('error' in resolved) return { success: false, kind: resolved.kind, error: resolved.error };
    const { position, ambiguous } = resolved;
    const at = this.location(sourceFile, position);

    let groups = this.service.findReferences(absFile, position);
    if (!groups?.length) {
      return {
        success: false,
        kind: 'not-found',
        error: `No symbol at ${at.file}:${at.line}:${at.column}`,
      };
    }

    // Starting from the renamed end of `export { a as b }` finds only the alias side:
    // references do not cross a rename backwards, though they do forwards. Query from
    // the original too, so the answer does not depend on which name was asked about.
    let origin = { file: absFile, position };
    if (groups.every((g) => g.definition.kind === ts.ScriptElementKind.alias)) {
      const target = this.service
        .getDefinitionAtPosition(absFile, position)
        ?.find((d) => d.kind !== ts.ScriptElementKind.alias);
      const more = target && this.service.findReferences(target.fileName, target.textSpan.start);
      if (target && more?.length) {
        groups = [...groups, ...more];
        origin = { file: target.fileName, position: target.textSpan.start };
      }
    }

    const maxResults = Math.min(
      Math.max(1, Math.floor(query.maxResults ?? DEFAULT_MAX_RESULTS)),
      MAX_RESULTS_CEILING,
    );

    // Every group, not the first: an aliased import or a re-export is its own group,
    // and dropping it is exactly the reference a grep would also have missed.
    const definitions = new Map<string, ReferenceDefinition>();
    const entries = new Map<string, TS.ReferencedSymbolEntry>();
    for (const group of groups) {
      const def = group.definition;
      const defFile = program.getSourceFile(def.fileName);
      if (defFile) {
        const loc = this.location(defFile, def.textSpan.start);
        definitions.set(`${def.fileName}:${def.textSpan.start}`, {
          ...loc,
          // `def.name` is display text (`const x: Accessor<number>`); the span is the name.
          name: defFile.text.slice(def.textSpan.start, def.textSpan.start + def.textSpan.length),
          kind: def.kind,
        });
      }
      for (const ref of group.references) {
        if (!this.inProject(ref.fileName)) continue;
        const key = `${ref.fileName}:${ref.textSpan.start}`;
        const seen = entries.get(key);
        // Keep the richer flags when two groups report one span.
        if (!seen || (ref.isDefinition && !seen.isDefinition)) entries.set(key, ref);
      }
    }

    const ordered = [...entries.values()].sort((a, b) =>
      a.fileName === b.fileName
        ? a.textSpan.start - b.textSpan.start
        : a.fileName < b.fileName
          ? -1
          : 1,
    );

    const hits: ReferenceHit[] = [];
    const callSites: { hit: ReferenceHit; owner: Enclosing | null }[] = [];
    for (const entry of ordered) {
      const file = program.getSourceFile(entry.fileName);
      if (!file) continue;
      const node = nodeAt(ts, file, entry.textSpan.start);
      const owner = enclosingOf(ts, node);
      const hit: ReferenceHit = {
        ...this.location(file, entry.textSpan.start),
        text: lineText(file, entry.textSpan.start),
        enclosing: owner?.name ?? null,
      };
      const role = importExportRole(ts, node);
      if (entry.isDefinition) hit.isDefinition = true;
      // TS counts an import binding as a write; for a reader it is not one.
      if (entry.isWriteAccess && !role) hit.isWrite = true;
      if (isCallee(ts, node)) {
        hit.isCall = true;
        callSites.push({ hit, owner });
      }
      if (role) hit.role = role;
      hits.push(hit);
    }

    // Each importing file's alias is a definition group of its own; those are already
    // listed as `role: 'import'` references, so they only stand in when nothing else does.
    const allDefinitions = [...definitions.values()];
    const realDefinitions = allDefinitions.filter((d) => d.kind !== ts.ScriptElementKind.alias);

    const result: Extract<FindReferencesResult, { success: true }> = {
      success: true,
      symbol: identifierAt(ts, sourceFile, position) ?? query.symbol ?? '',
      at,
      ...(ambiguous.length ? { ambiguous } : {}),
      definitions: realDefinitions.length ? realDefinitions : allDefinitions,
      references: hits.slice(0, maxResults),
      totalReferences: hits.length,
      files: new Set(hits.map((h) => h.file)).size,
    };

    let truncated = hits.length > maxResults;
    if (query.callers) {
      const fromHierarchy = this.hierarchyCallers(origin.file, origin.position);
      const callers = fromHierarchy ?? derivedCallers(this, callSites);
      result.callersFrom = fromHierarchy ? 'call-hierarchy' : 'references';
      result.callers = callers.slice(0, maxResults);
      if (callers.length > maxResults) truncated = true;
    }
    if (truncated) result.truncated = true;
    return result;
  }

  /**
   * Incoming calls, or null when call hierarchy cannot start here at all — which is
   * the signal to derive callers from references instead.
   */
  private hierarchyCallers(absFile: string, position: number): CallerHit[] | null {
    const prepared = this.service.prepareCallHierarchy(absFile, position);
    const items = prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared];
    if (items.length === 0) return null;

    const program = this.service.getProgram()!;
    const callers = new Map<string, CallerHit>();
    for (const item of items) {
      for (const call of this.service.provideCallHierarchyIncomingCalls(
        item.file,
        item.selectionSpan.start,
      )) {
        const { from } = call;
        if (!this.inProject(from.file)) continue;
        const file = program.getSourceFile(from.file);
        if (!file) continue;
        const script = from.kind === this.ts.ScriptElementKind.scriptElement;
        const caller = script
          ? TOP_LEVEL
          : from.containerName
            ? `${from.containerName}.${from.name}`
            : from.name;
        const loc = this.location(file, from.selectionSpan.start);
        const key = `${loc.file}:${caller}:${script ? 0 : loc.line}`;
        const entry = callers.get(key) ?? {
          caller,
          kind: from.kind,
          file: loc.file,
          line: script ? this.location(file, call.fromSpans[0]?.start ?? 0).line : loc.line,
          calls: [],
        };
        for (const span of call.fromSpans) {
          const { line, column } = this.location(file, span.start);
          entry.calls.push({ line, column });
        }
        callers.set(key, entry);
      }
    }
    return [...callers.values()];
  }

  private resolvePosition(
    file: TS.SourceFile,
    query: FindReferencesQuery,
  ):
    | { position: number; ambiguous: SourceLocation[] }
    | { kind: 'invalid' | 'not-found'; error: string } {
    const lineCount = file.getLineStarts().length;
    if (query.line !== undefined && (query.line < 1 || query.line > lineCount)) {
      return {
        kind: 'invalid',
        error: `line ${query.line} is outside ${this.rel(file.fileName)} (1-${lineCount})`,
      };
    }

    if (query.line !== undefined && query.column !== undefined) {
      const lineStart = file.getLineStarts()[query.line - 1];
      const lineEnd = file.getLineEndOfPosition(lineStart);
      const position = lineStart + query.column - 1;
      if (query.column < 1 || position > lineEnd) {
        return { kind: 'invalid', error: `column ${query.column} is outside line ${query.line}` };
      }
      return { position, ambiguous: [] };
    }

    const symbol = query.symbol?.trim();
    if (!symbol) {
      return { kind: 'invalid', error: 'Give "symbol", "line" + "column", or "line" + "symbol"' };
    }
    const segments = symbol.split('.');
    const name = segments[segments.length - 1];

    if (query.line !== undefined) {
      const onLine = findIdentifiers(this.ts, file, name).find(
        (id) => file.getLineAndCharacterOfPosition(id.getStart(file)).line === query.line! - 1,
      );
      if (!onLine) {
        return { kind: 'not-found', error: `"${name}" does not appear on line ${query.line}` };
      }
      return { position: onLine.getStart(file), ambiguous: [] };
    }

    const candidates = declarationsNamed(this.ts, file, segments);
    if (candidates.length === 0) {
      return {
        kind: 'not-found',
        error: `No declaration of "${symbol}" in ${this.rel(file.fileName)}`,
      };
    }
    const [best, ...rest] = candidates;
    return {
      position: best.getStart(file),
      ambiguous: rest.map((c) => this.location(file, c.getStart(file))),
    };
  }

  location(file: TS.SourceFile, position: number): SourceLocation {
    const { line, character } = file.getLineAndCharacterOfPosition(position);
    return { file: this.rel(file.fileName), line: line + 1, column: character + 1 };
  }

  private inProject(fileName: string): boolean {
    return fwd(fileName).startsWith(`${this.root}/`);
  }

  /** Sandbox-relative, or a stable label for a file outside the sandbox. */
  private rel(fileName: string): string {
    const f = fwd(fileName);
    if (this.inProject(f)) return fwd(relative(this.root, f));
    if (f === SLICED_TYPES_PATH || f === BUNDLED_TYPES_DTS) return '@bundled-types/index.d.ts';
    const nm = f.lastIndexOf('/node_modules/');
    if (nm >= 0) {
      const rest = f.slice(nm + '/node_modules/'.length);
      return rest.startsWith('typescript/lib/') ? rest.slice('typescript/lib/'.length) : rest;
    }
    return f;
  }
}

// ── AST helpers ──────────────────────────────────────────────────────────────

interface Enclosing {
  name: string;
  kind: string;
  node: TS.Node;
}

/** The deepest node whose span covers `position`. */
function nodeAt(ts: typeof TS, file: TS.SourceFile, position: number): TS.Node {
  let current: TS.Node = file;
  for (;;) {
    const next: TS.Node | undefined = ts.forEachChild(current, (child) =>
      child.getStart(file) <= position && position < child.end ? child : undefined,
    );
    if (!next) return current;
    current = next;
  }
}

function lineText(file: TS.SourceFile, position: number): string {
  const { line } = file.getLineAndCharacterOfPosition(position);
  const start = file.getLineStarts()[line];
  const text = file.text.slice(start, file.getLineEndOfPosition(start)).trim();
  return text.length > TEXT_CLIP ? `${text.slice(0, TEXT_CLIP)}…` : text;
}

function nameText(ts: typeof TS, name: TS.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * The dotted path of named containers around a node: class, interface, enum,
 * namespace, and an object literal bound to a name. Function bodies are not
 * containers — a local `helper` inside `render` is still just `helper`.
 */
function containerPath(ts: typeof TS, node: TS.Node): string[] {
  const path: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isClassLike(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isModuleDeclaration(p)
    ) {
      const n = nameText(ts, p.name);
      if (n) path.unshift(n);
    } else if (ts.isObjectLiteralExpression(p)) {
      const owner = bindingOwner(ts, p);
      if (
        owner &&
        (ts.isVariableDeclaration(owner) ||
          ts.isPropertyAssignment(owner) ||
          ts.isPropertyDeclaration(owner))
      ) {
        const n = nameText(ts, owner.name);
        if (n) path.unshift(n);
      }
    }
  }
  return path;
}

/**
 * What a value expression is bound to, looking through the wrappers an app puts
 * around a descriptor: `defineAppCommand({...})`, `{...} as const`, `satisfies`,
 * parentheses. Without this every `run` in a command map is just `commands.run`.
 */
function bindingOwner(ts: typeof TS, node: TS.Node): TS.Node | undefined {
  let current = node;
  let parent = node.parent;
  while (
    parent &&
    ((ts.isCallExpression(parent) && parent.arguments.some((a) => a === current)) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isParenthesizedExpression(parent))
  ) {
    current = parent;
    parent = parent.parent;
  }
  return parent;
}

function identifierAt(ts: typeof TS, file: TS.SourceFile, position: number): string | undefined {
  const node = nodeAt(ts, file, position);
  return ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : undefined;
}

function isFunctionBoundary(ts: typeof TS, node: TS.Node): boolean {
  return ts.isFunctionLike(node) && !ts.isClassLike(node);
}

/** Declarations in `file` whose container path ends with `segments`, best first. */
function declarationsNamed(ts: typeof TS, file: TS.SourceFile, segments: string[]): TS.Node[] {
  const name = segments[segments.length - 1];
  const found: { node: TS.Node; rank: number }[] = [];

  const visit = (node: TS.Node, depth: number): void => {
    let declName: TS.Node | undefined;
    let isImport = false;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassLike(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isEnumMember(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isBindingElement(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      declName = node.name;
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      declName = node.name;
      isImport = true;
    } else if (ts.isImportClause(node) && node.name) {
      declName = node.name;
      isImport = true;
    }

    if (declName && nameText(ts, declName) === name) {
      const path = [...containerPath(ts, node), name];
      const tail = path.slice(-segments.length);
      if (tail.length === segments.length && tail.every((s, i) => s === segments[i])) {
        // An exact path beats a suffix match; a module-scope declaration beats one
        // nested in a function; a real declaration beats the import of one.
        const rank =
          (path.length === segments.length ? 0 : 100) + depth * 10 + (isImport ? 1_000 : 0);
        found.push({ node: declName, rank });
      }
    }

    const childDepth = isFunctionBoundary(ts, node) ? depth + 1 : depth;
    ts.forEachChild(node, (child) => visit(child, childDepth));
  };
  visit(file, 0);

  return found.sort((a, b) => a.rank - b.rank || a.node.pos - b.node.pos).map((f) => f.node);
}

function findIdentifiers(ts: typeof TS, file: TS.SourceFile, name: string): TS.Node[] {
  const out: TS.Node[] = [];
  const visit = (node: TS.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === name) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The innermost *named* function or method around a node; anonymous callbacks are skipped. */
function enclosingOf(ts: typeof TS, node: TS.Node): Enclosing | null {
  for (let p = node.parent; p; p = p.parent) {
    if (!isFunctionBoundary(ts, p)) continue;
    const qualify = (n: string, at: TS.Node) => [...containerPath(ts, at), n].join('.');

    if (ts.isFunctionDeclaration(p) && p.name) {
      return { name: qualify(p.name.text, p), kind: 'function', node: p };
    }
    if (ts.isConstructorDeclaration(p)) {
      return { name: qualify('constructor', p), kind: 'constructor', node: p };
    }
    if (
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    ) {
      const n = nameText(ts, p.name);
      const kind = ts.isMethodDeclaration(p) ? 'method' : ts.isGetAccessor(p) ? 'getter' : 'setter';
      if (n) return { name: qualify(n, p), kind, node: p };
    }
    if (ts.isFunctionExpression(p) || ts.isArrowFunction(p)) {
      if (ts.isFunctionExpression(p) && p.name) {
        return { name: qualify(p.name.text, p), kind: 'function', node: p };
      }
      const owner = bindingOwner(ts, p);
      if (
        owner &&
        (ts.isVariableDeclaration(owner) ||
          ts.isPropertyAssignment(owner) ||
          ts.isPropertyDeclaration(owner))
      ) {
        const n = nameText(ts, owner.name);
        if (n) {
          const kind = ts.isVariableDeclaration(owner) ? 'function' : 'method';
          return { name: qualify(n, owner), kind, node: owner };
        }
      }
    }
  }
  return null;
}

/** Is this identifier the thing being called — `f()`, `a.f()`, `new F()`, `` f`...` ``? */
function isCallee(ts: typeof TS, node: TS.Node): boolean {
  let target: TS.Node = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    target = node.parent;
  }
  const parent = target.parent;
  if (!parent) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === target) {
    return true;
  }
  return ts.isTaggedTemplateExpression(parent) && parent.tag === target;
}

function importExportRole(ts: typeof TS, node: TS.Node): 'import' | 'export' | undefined {
  for (let p: TS.Node | undefined = node.parent, i = 0; p && i < 3; p = p.parent, i++) {
    if (
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p)
    ) {
      return 'import';
    }
    if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return 'export';
  }
  return undefined;
}

/**
 * Callers for a symbol call hierarchy cannot start from — a variable holding a
 * function, a signal setter — grouped from the call-site references themselves.
 */
function derivedCallers(
  service: SandboxReferences,
  callSites: { hit: ReferenceHit; owner: Enclosing | null }[],
): CallerHit[] {
  const callers = new Map<string, CallerHit>();
  for (const { hit, owner } of callSites) {
    const ownerLoc = owner
      ? service.location(owner.node.getSourceFile(), owner.node.getStart())
      : null;
    const caller = owner?.name ?? TOP_LEVEL;
    const key = `${hit.file}:${caller}:${ownerLoc?.line ?? 0}`;
    const entry = callers.get(key) ?? {
      caller,
      kind: owner?.kind ?? 'script',
      file: hit.file,
      line: ownerLoc?.line ?? hit.line,
      calls: [],
    };
    entry.calls.push({ line: hit.line, column: hit.column });
    callers.set(key, entry);
  }
  return [...callers.values()];
}
