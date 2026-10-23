/**
 * The exports a `@bundled/*` module takes wholesale from an npm package.
 *
 * Most bundled modules are declared as one line — `export * from 'diff'` — so the
 * text slicing in `describe-library.ts` found nothing to list: `diff` answered
 * "0 exports in 0 sections", and an agent hand-wrote the line diff the library
 * already ships. The names live in the package's own `.d.ts`, behind whatever mix of
 * `export { a } from`, `export default`, ambient `declare module` and `export =` its
 * author chose, which is a job for the TypeScript checker rather than more regexes.
 *
 * Resolution runs from the compiler package, where the libraries are devDependencies.
 * Where that tree is absent (the bundled exe) or `typescript` is, every lookup answers
 * `null` and the description falls back to the module block alone.
 */

import { join } from 'path';
import type TS from 'typescript';

type TsModule = typeof import('typescript');
import { loadTypeScript } from '../load-typescript.js';
import { PACKAGE_ROOT } from '../paths.js';
import {
  clip,
  firstSentence,
  SIGNATURE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  withoutExportKeyword,
} from './describe-summary.js';

export type UpstreamKind =
  'function' | 'class' | 'const' | 'namespace' | 'interface' | 'type' | 'enum';

export interface UpstreamExport {
  name: string;
  kind: UpstreamKind;
  /** First sentence of the doc comment, or `''`. */
  summary: string;
  /** Doc comment plus declaration(s), dedented. Capped for very large classes. */
  text: string;
}

export interface UpstreamModule {
  /** The npm specifier, e.g. `diff` or `solid-js/web`. */
  specifier: string;
  /** The names are members of the package's `export =` value, reached via the default import. */
  ofDefault: boolean;
  exports: UpstreamExport[];
}

/** One export's declaration past this is cut — `Object3D` alone is ~40KB. */
const MAX_DECLARATION_CHARS = 12_000;

const cache = new Map<string, Promise<UpstreamModule | null>>();

/**
 * The npm specifiers a `declare module '@bundled/…'` block forwards wholesale:
 * every `export * from 'x'`, and `export = X` where `X` was imported from `'x'`.
 */
export function upstreamSpecifiers(block: string): string[] {
  const specs = [...block.matchAll(/^\s*export \* from '([^']+)';/gm)].map((m) => m[1]);
  const assigned = /^\s*export = (\w+);/m.exec(block)?.[1];
  if (assigned) {
    const from = new RegExp(`^\\s*import (?:\\* as )?${assigned} from '([^']+)';`, 'm').exec(
      block,
    )?.[1];
    if (from) specs.push(from);
  }
  return specs;
}

export function loadUpstreamModule(specifier: string): Promise<UpstreamModule | null> {
  let hit = cache.get(specifier);
  if (!hit) {
    hit = loadTypeScript()
      .then((ts) => (ts ? readUpstream(ts, specifier) : null))
      .catch(() => null);
    cache.set(specifier, hit);
  }
  return hit;
}

function readUpstream(ts: TsModule, specifier: string): UpstreamModule | null {
  const options: TS.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  };
  const resolved = ts.resolveModuleName(
    specifier,
    join(PACKAGE_ROOT, '__describe__.ts'),
    options,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return null;

  const program = ts.createProgram([resolved], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolved);
  if (!source) return null;

  // A file of `declare module "x" { … }` blocks (cannon-es) is not itself a module;
  // the package's entry is the ambient module named after it.
  const moduleSymbol =
    checker.getSymbolAtLocation(source) ??
    checker.getAmbientModules().find((m) => m.name === `"${specifier}"`);
  if (!moduleSymbol) return null;

  let symbols = checker.getExportsOfModule(moduleSymbol);
  let ofDefault = false;
  if (symbols.length === 0) {
    // `export = value` of a non-namespace (mammoth's `declare const mammoth: Mammoth`)
    // has no named exports; what an importer reaches is the value's properties.
    const assigned = moduleSymbol.exports?.get('export=' as TS.__String);
    if (assigned) {
      const target = resolveAlias(ts, checker, assigned);
      symbols = checker.getPropertiesOfType(checker.getTypeOfSymbol(target));
      ofDefault = true;
    }
  }

  const exports: UpstreamExport[] = [];
  for (const symbol of symbols) {
    if (symbol.name === 'default' || symbol.name === 'export=') continue;
    const target = resolveAlias(ts, checker, symbol);
    const kind = kindOf(ts, target);
    if (!kind) continue;
    const declarations = (target.declarations ?? []).filter(
      (d) => !ts.isSourceFile(d) && d.getSourceFile() !== undefined,
    );
    // Overloads print as one block; merged declarations (a class and its namespace) apart.
    const text = declarations.length
      ? capText(
          declarations
            .map((d, i) => (i > 0 && ts.isFunctionLike(d) ? '\n' : '\n\n') + declarationText(ts, d))
            .join('')
            .trimStart(),
        )
      : `// ${symbol.name}: ${kind} (no declaration text)`;
    const doc = ts.displayPartsToString(target.getDocumentationComment(checker));
    exports.push({
      name: symbol.name,
      kind,
      summary: doc.trim() ? clip(firstSentence(doc), SUMMARY_MAX_CHARS) : signatureLine(text),
      text,
    });
  }
  exports.sort((a, b) => a.name.localeCompare(b.name));
  return { specifier, ofDefault, exports };
}

function resolveAlias(ts: TsModule, checker: TS.TypeChecker, symbol: TS.Symbol): TS.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Value kinds before type kinds: a class merged with an interface is still a class. */
function kindOf(ts: TsModule, symbol: TS.Symbol): UpstreamKind | null {
  const f = symbol.flags;
  const S = ts.SymbolFlags;
  if (f & S.Class) return 'class';
  if (f & (S.Function | S.Method)) return 'function';
  if (f & S.Enum) return 'enum';
  if (f & (S.Variable | S.Property | S.Accessor)) return 'const';
  if (f & S.ValueModule) return 'namespace';
  if (f & S.Interface) return 'interface';
  if (f & S.TypeAlias) return 'type';
  if (f & S.NamespaceModule) return 'namespace';
  return null;
}

/** The node's own source plus the JSDoc block directly above it. */
function declarationText(ts: TsModule, decl: TS.Declaration): string {
  // A `const` is printed as its statement, so the `export declare const` reads as written.
  const node =
    ts.isVariableDeclaration(decl) && ts.isVariableStatement(decl.parent.parent)
      ? decl.parent.parent
      : decl;
  const sf = node.getSourceFile();
  const docs = (ts.getLeadingCommentRanges(sf.text, node.pos) ?? []).filter((r) =>
    sf.text.startsWith('/**', r.pos),
  );
  const start = docs.length ? docs[docs.length - 1].pos : node.getStart(sf);
  const column = sf.getLineAndCharacterOfPosition(start).character;
  const raw = sf.text.slice(start, node.end);
  const indent = new RegExp(`^[ \\t]{0,${column}}`);
  return raw
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(indent, '')))
    .join('\n');
}

function capText(text: string): string {
  if (text.length <= MAX_DECLARATION_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_DECLARATION_CHARS);
  const kept = text.slice(0, cut > 0 ? cut : MAX_DECLARATION_CHARS);
  const dropped = text.slice(kept.length).split('\n').length;
  return `${kept}\n// … ${dropped} more lines not shown`;
}

/** An undocumented export's index line: its declaration, collapsed. */
function signatureLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
  const collapsed = withoutExportKeyword((line ?? '').trim())
    .replace(/[;{]\s*$/, '')
    .trim();
  return clip(collapsed, SIGNATURE_MAX_CHARS);
}
