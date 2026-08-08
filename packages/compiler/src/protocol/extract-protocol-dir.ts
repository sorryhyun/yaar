/**
 * Extract an app's protocol manifest from its source directory.
 *
 * This is the single entry point both the compiler and the deploy path use, so
 * a manifest never depends on which caller asked for it. The AST extractor
 * (`extract-protocol-ast.ts`) does the work: it follows relative imports and
 * spreads, so descriptor maps may be split across files, and it reports anything
 * unresolvable as a hard error.
 *
 * Without `typescript` there is no AST, but a `defineApp` app is still readable
 * by *running* it — its manifest is the entry module's default export — so the
 * schema fold produces the whole manifest there. `degraded` says which of the
 * two environments answered.
 */

import { dirname, join } from 'path';
import type { AppManifest } from '@yaar/shared';
import { toForwardSlash } from '../bundled/registry.js';
import { AppSourceCache } from '../build/source-cache.js';
import {
  APP_REGISTER_REMOVED_MESSAGE,
  extractProtocolFromModules,
  type ProtocolError,
} from './extract-protocol-ast.js';
import { loadTypeScript } from '../load-typescript.js';
import { dedupeProtocolSchemas } from './dedupe-schemas.js';
import { foldAppSchemas, type FoldSuccess } from './fold-schemas.js';

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events' | 'keybindings' | '$defs'>;

/** Entry candidates, in order. The first that holds a registration wins. */
const ENTRY_FILES = ['main.ts', 'protocol.ts'] as const;

/** Extensions `resolveModulePath` will try — anything a specifier could name. */
const MODULE_EXTENSIONS = /\.(ts|tsx|mts|js|jsx)$/;

export interface DirExtraction {
  /** The manifest, or null when the app declares no protocol (or was refused). */
  protocol: Protocol | null;
  /**
   * Constructs the extractor refused to guess at. Non-empty means the caller
   * must fail: a manifest parsed around an unresolvable descriptor is a
   * manifest missing commands, and a command an agent cannot see is a command
   * that does not exist.
   */
  errors: ProtocolError[];
  /**
   * True when `typescript` was unavailable, so there was no AST to read and the
   * manifest came from running the app instead.
   */
  degraded: boolean;
}

/**
 * Read every TypeScript file under `srcDir`, keyed by path relative to the app
 * root (`src/foo.ts`) so extractor diagnostics name a path the author
 * recognizes.
 */
function readModuleTexts(srcDir: string, sources?: AppSourceCache): Map<string, string> {
  // Matches the extensions `resolveModulePath` will try, so a specifier that
  // resolves in principle can also be read.
  return (sources ?? new AppSourceCache(srcDir)).collect(MODULE_EXTENSIONS);
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
  /**
   * The caller's per-compile source cache. `compileTypeScript` passes the one it
   * already filled for the token guard; the deploy and tooling paths pass none
   * and this reads the directory itself.
   */
  sources?: AppSourceCache;
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

/**
 * The one place the `$defs` fold is applied, so both readers answer alike.
 *
 * It sits here rather than in `compile.ts` because this function is what the deploy
 * path re-derives a manifest with (`features/dev/deploy.ts` diffs the two): a pass
 * applied on only one of the two roads would report every deploy as a protocol
 * change. The pass is idempotent, so re-running it over a manifest that already
 * carries `$defs` is a no-op.
 */
function folded(protocol: Protocol | null): Protocol | null {
  return protocol ? dedupeProtocolSchemas(protocol) : protocol;
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
      texts = readModuleTexts(srcDir, options.sources);
    } catch (err) {
      // Not the same as "this app declares no protocol", and must not report as
      // it: an unreadable source directory is a failure to *look*, and the
      // caller would otherwise ship an empty manifest as though it were true.
      return {
        protocol: null,
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
      // A registration that was found and rejected must not fall through to the
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
        protocol: errors.length > 0 ? null : folded(result.protocol),
        errors,
        degraded: false,
      };
    }
    return { protocol: null, errors: [], degraded: false };
  }

  for (const file of ENTRY_FILES) {
    let source: string;
    try {
      source = await Bun.file(join(srcDir, file)).text();
    } catch {
      continue;
    }
    // A `defineApp` app survives the missing AST because its manifest is
    // reachable at runtime: the fold builds the entry and asks its default
    // export directly, which is the registration the iframe will serve.
    if (/\bdefineApp\s*\(/.test(source)) {
      const fold = await foldAppSchemas({ appPath, bundles: options.bundles });
      if (!fold.ok) {
        return {
          protocol: null,
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
        protocol: mismatch.length > 0 ? null : folded(fold.protocol),
        errors: mismatch,
        degraded: true,
      };
    }
  }

  // No `defineApp`, so nothing the fold can read. Check for the removed
  // `app.register({...})` (see `findAppRegisterCall` in extract-protocol-ast.ts for the
  // guard's rationale) before reporting no protocol at all.
  const registers = findRegisterCall(srcDir, options.sources);
  if (registers) {
    return {
      protocol: null,
      errors: [{ message: APP_REGISTER_REMOVED_MESSAGE, file: registers, line: 1, column: 1 }],
      degraded: true,
    };
  }

  return { protocol: null, errors: [], degraded: true };
}

/**
 * The first source file calling `app.register(`, or null if none does.
 *
 * A text test, deliberately: it decides whether the app *claims* a protocol the
 * platform no longer serves, not what that protocol is. An app that claims none
 * (most apps only draw a UI) must keep building.
 *
 * `app` must still be the SDK's, the way the AST path resolves its receiver, so
 * the two readers answer alike: the file has to import `app` from
 * '@bundled/yaar' or spell the call through the global (`window.yaar.app`). A
 * file with its own `app` — `const app = registry; app.register({ hooks: {} })`
 * — is not this app's registration and must not fail the build. Without a
 * binding resolver the import is the closest available proxy for the same rule.
 */
function findRegisterCall(srcDir: string, sources?: AppSourceCache): string | null {
  const rank = (path: string): number => {
    const index = ENTRY_FILES.findIndex((file) => path === `src/${file}`);
    return index === -1 ? ENTRY_FILES.length : index;
  };

  let texts: Map<string, string>;
  try {
    texts = readModuleTexts(srcDir, sources);
  } catch {
    return null;
  }
  // Entry files first, so the error anchors to the file an author would open.
  const paths = [...texts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const path of paths) {
    const text = texts.get(path)!;
    if (/\byaar\s*\.\s*app\s*\.\s*register\s*\(/.test(text)) return path;
    if (/\bapp\s*\.\s*register\s*\(/.test(text) && importsSdkApp(text)) return path;
  }
  return null;
}

/**
 * True when `text` binds `app` from '@bundled/yaar' — `import { app }`, or a
 * destructure off the namespace. Deliberately not a parser: it stands in for the
 * AST path's receiver resolution in the one environment that has no `typescript`
 * to resolve with.
 */
function importsSdkApp(text: string): boolean {
  const namedImport = /import\s*\{([^}]*)\}\s*from\s*['"]@bundled\/yaar['"]/g;
  for (const match of text.matchAll(namedImport)) {
    const binds = match[1]
      .split(',')
      .some((clause) => /^\s*app\s*(?:as\s+\w+\s*)?$/.test(clause.replace(/\/\/.*$/, '')));
    if (binds) return true;
  }
  return /\bconst\s*\{[^}]*\bapp\b[^}]*\}\s*=\s*(?:window\s*\.\s*)?yaar\b/.test(text);
}
