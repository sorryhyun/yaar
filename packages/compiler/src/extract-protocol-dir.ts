/**
 * Extract an app's protocol manifest from its source directory.
 *
 * This is the single entry point both the compiler and the deploy path use, so
 * a manifest never depends on which caller asked for it. Two extractors sit
 * behind it:
 *
 *  - the AST extractor (`extract-protocol-ast.ts`), whenever `typescript` loads.
 *    It follows relative imports and spreads, so descriptor maps may be split
 *    across files, and it reports anything unresolvable as a hard error.
 *  - the text scanner (`extract-protocol.ts`), in bundled-exe mode where
 *    `typescript` is absent. It stops at the first spread, so it keeps its
 *    warning-based gate; `degraded` says that this is what ran.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { AppManifest } from '@yaar/shared';
import { toForwardSlash } from './plugins.js';
import { extractProtocolWithDiagnostics, type ProtocolExtraction } from './extract-protocol.js';
import { extractProtocolFromModules, type ProtocolError } from './extract-protocol-ast.js';
import { loadTypeScript } from './load-typescript.js';
import { foldAppSchemas, type FoldSuccess } from './fold-schemas.js';

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events'>;

/** Entry candidates, in order. The first that holds a `register()` wins. */
const ENTRY_FILES = ['main.ts', 'protocol.ts'] as const;

export interface DirExtraction extends ProtocolExtraction {
  /**
   * Constructs the extractor refused to guess at. Non-empty means the caller
   * must fail: a manifest parsed around an unresolvable descriptor is a
   * manifest missing commands, and a command an agent cannot see is a command
   * that does not exist.
   */
  errors: ProtocolError[];
  /** True when the text scanner ran because `typescript` was unavailable. */
  degraded: boolean;
}

/**
 * Read every TypeScript file under `srcDir`, keyed by path relative to the app
 * root (`src/foo.ts`) so extractor diagnostics name a path the author
 * recognizes.
 */
function readModuleTexts(srcDir: string): Map<string, string> {
  const texts = new Map<string, string>();
  // Matches the extensions `resolveModulePath` will try, so a specifier that
  // resolves in principle can also be read.
  const entries = new Bun.Glob('**/*.{ts,tsx,mts,js,jsx}').scanSync({
    cwd: srcDir,
    onlyFiles: true,
  });
  for (const rel of entries) {
    try {
      texts.set(toForwardSlash(join('src', rel)), readFileSync(join(srcDir, rel), 'utf8'));
    } catch {
      // Unreadable file — the bundler reports it far better than we can.
    }
  }
  return texts;
}

export interface DirExtractOptions {
  /**
   * The app's `app.json` `appId`. `defineApp`'s `id` must equal it.
   *
   * Left out, it is read from `<srcDir>/../app.json` — every caller lays the app
   * out that way, and deriving it here means the check holds for the deploy and
   * tooling paths too, not only for a compile that happens to pass it. A
   * sandbox with no app.json yields undefined, which skips the check rather than
   * failing a scratch build that has no id to disagree with.
   */
  appId?: string;
  /**
   * The app's `app.json` `bundles`. Only the schema fold reads it, so that the
   * throwaway bundle it builds resolves gated SDKs exactly as the app build did
   * — an app importing `@bundled/yaar-web` must not fail the fold on a gate it
   * already passed.
   */
  bundles?: string[];
}

/**
 * Split a `pendingFolds` path into the descriptor it addresses.
 *
 * Section first and property last, rather than a plain three-way split: a
 * command may be declared under a quoted key containing a dot
 * (`'current.path': {...}` is legal and shipped apps use quoted keys), and a
 * naive split would then address a command that does not exist and report the
 * schema as unfoldable.
 */
function splitFoldPath(path: string): { section: string; key: string; prop: string } | null {
  const first = path.indexOf('.');
  const last = path.lastIndexOf('.');
  if (first === -1 || first === last) return null;
  return {
    section: path.slice(0, first),
    key: path.slice(first + 1, last),
    prop: path.slice(last + 1),
  };
}

/** Locate a descriptor in a protocol, or undefined when it has no such entry. */
function descriptorAt(protocol: Protocol, path: string): Record<string, unknown> | undefined {
  const parts = splitFoldPath(path);
  if (!parts) return undefined;
  const bag =
    parts.section === 'commands'
      ? protocol.commands
      : parts.section === 'state'
        ? protocol.state
        : undefined;
  return bag?.[parts.key] as unknown as Record<string, unknown> | undefined;
}

/** One folded schema, addressed the way `pendingFolds` spells it. */
function readFoldedSchema(protocol: Protocol, path: string): object | undefined {
  const value = descriptorAt(protocol, path)?.[splitFoldPath(path)!.prop];
  return value && typeof value === 'object' ? (value as object) : undefined;
}

/** Write one folded schema back onto the statically-extracted manifest. */
function writeFoldedSchema(protocol: Protocol, path: string, value: object): void {
  const descriptor = descriptorAt(protocol, path);
  if (descriptor) descriptor[splitFoldPath(path)!.prop] = value;
}

/**
 * Explain a fold that never got far enough to answer.
 *
 * Naming the deferred paths is the point: the fold ran because *these* schemas
 * are not constants, so an author reading "the app threw while being imported"
 * with no further context would have no way to connect it to the `z.object(...)`
 * they just wrote.
 */
function foldFailureMessage(pendingFolds: string[], error: string): string {
  return (
    `${pendingFolds.join(', ')}: not compile-time constants, so the manifest needs the app ` +
    `run to read them, and that failed. ${error}`
  );
}

/**
 * Fill the AST manifest's deferred schemas in from the running app.
 *
 * The static manifest stays authoritative for everything else — descriptions,
 * aliases, replay policy, which entries exist. Only the paths the evaluator
 * explicitly deferred are taken from the fold, so a runtime pass cannot quietly
 * add or reword an entry.
 *
 * The one thing it *is* allowed to do is disagree about which commands exist.
 * That disagreement is the failure this whole subsystem exists to prevent — a
 * command the iframe answers and the manifest never mentions — so it is reported
 * rather than reconciled.
 */
function mergeFold(
  protocol: Protocol,
  pendingFolds: string[],
  fold: FoldSuccess,
  entryFile: string,
): ProtocolError[] {
  const errors: ProtocolError[] = [];
  const at = (message: string): ProtocolError => ({ message, file: entryFile, line: 1, column: 1 });

  for (const path of pendingFolds) {
    const value = readFoldedSchema(fold.protocol, path);
    if (!value) {
      errors.push(
        at(
          `\`${path}\`: not a compile-time constant, and running the app produced no schema ` +
            `for it either. Use a Zod schema or a JSON Schema object literal`,
        ),
      );
      continue;
    }
    writeFoldedSchema(protocol, path, value);
  }

  for (const section of ['commands', 'state'] as const) {
    const known = new Set(Object.keys(protocol[section]));
    const missing = Object.keys(fold.protocol[section]).filter((key) => !known.has(key));
    if (missing.length > 0) {
      errors.push(
        at(
          `the running app declares ${section} the manifest does not name ` +
            `(${missing.join(', ')}); an entry an agent cannot see does not exist`,
        ),
      );
    }
  }

  return errors;
}

/** Read `appId` from the app.json beside `srcDir`, or undefined if there is none. */
async function readAppJsonId(srcDir: string): Promise<string | undefined> {
  try {
    const json = JSON.parse(await Bun.file(join(srcDir, '..', 'app.json')).text());
    const id = json?.appId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the protocol manifest for the app whose sources live in `srcDir`. */
export async function extractProtocolFromDir(
  srcDir: string,
  options: DirExtractOptions = {},
): Promise<DirExtraction> {
  const ts = await loadTypeScript();
  const appId = options.appId ?? (await readAppJsonId(srcDir));
  const appPath = dirname(srcDir);

  if (ts) {
    let texts: Map<string, string>;
    try {
      texts = readModuleTexts(srcDir);
    } catch (err) {
      // Not the same as "this app declares no protocol", and must not report as
      // it: an unreadable source directory is a failure to *look*, and the
      // caller would otherwise ship an empty manifest as though it were true.
      return {
        protocol: null,
        warnings: [],
        errors: [
          {
            message: `app sources could not be read (${err instanceof Error ? err.name : 'unknown error'})`,
            file: 'src',
            line: 1,
            column: 1,
          },
        ],
        degraded: false,
      };
    }
    const readFile = (path: string): string | null => texts.get(toForwardSlash(path)) ?? null;
    for (const file of ENTRY_FILES) {
      const entry = `src/${file}`;
      if (!texts.has(entry)) continue;
      const result = extractProtocolFromModules(ts, entry, readFile, { appId });
      // A register() that was found and rejected must not fall through to the
      // next candidate: that would hide the very failure the errors describe.
      if (!result.protocol && result.errors.length === 0) continue;

      let errors = result.errors;
      if (result.protocol && errors.length === 0 && result.pendingFolds.length > 0) {
        const fold = await foldAppSchemas({ appPath, bundles: options.bundles });
        errors = fold.ok
          ? mergeFold(result.protocol, result.pendingFolds, fold, entry)
          : [
              {
                message: foldFailureMessage(result.pendingFolds, fold.error),
                file: entry,
                line: 1,
                column: 1,
              },
            ];
      }
      return {
        protocol: errors.length > 0 ? null : result.protocol,
        warnings: [],
        errors,
        degraded: false,
      };
    }
    return { protocol: null, warnings: [], errors: [], degraded: false };
  }

  // A file that produced warnings but no protocol still wins over the next
  // file: warnings mean a register() call was found and choked, and falling
  // through would hide exactly the truncation the diagnostics exist to surface.
  for (const file of ENTRY_FILES) {
    let source: string;
    try {
      source = await Bun.file(join(srcDir, file)).text();
    } catch {
      continue;
    }
    // The text scanner only knows `app.register({...})`, so a `defineApp` app
    // reads as "declares no protocol" here — an answer indistinguishable from
    // the truth while being wrong about every command the app has. There is no
    // AST to fall back on without `typescript`, but there is a running app: the
    // fold builds the entry and asks its default export directly, which is the
    // registration the iframe will actually serve.
    if (/\bdefineApp\s*\(/.test(source)) {
      const fold = await foldAppSchemas({ appPath, bundles: options.bundles });
      if (!fold.ok) {
        return {
          protocol: null,
          warnings: [],
          errors: [
            {
              message:
                'this app registers with `defineApp()`, which needs `typescript` to read ' +
                'statically; running it instead failed, so no manifest could be produced. ' +
                fold.error,
              file,
              line: 1,
              column: 1,
            },
          ],
          degraded: true,
        };
      }
      const mismatch =
        appId !== undefined && fold.id !== undefined && fold.id !== appId
          ? [
              {
                message:
                  `\`defineApp.id\`: declared \`${fold.id}\` but this app's app.json says ` +
                  `\`${appId}\`; the id is what the app registers under, so the two must agree`,
                file,
                line: 1,
                column: 1,
              },
            ]
          : [];
      return {
        protocol: mismatch.length > 0 ? null : fold.protocol,
        warnings: [],
        errors: mismatch,
        degraded: true,
      };
    }
    const extraction = extractProtocolWithDiagnostics(source);
    if (extraction.protocol || extraction.warnings.length > 0) {
      return { ...extraction, errors: [], degraded: true };
    }
  }
  return { protocol: null, warnings: [], errors: [], degraded: true };
}
