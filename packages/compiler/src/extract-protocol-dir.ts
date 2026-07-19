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
import { join } from 'path';
import { toForwardSlash } from './plugins.js';
import { extractProtocolWithDiagnostics, type ProtocolExtraction } from './extract-protocol.js';
import { extractProtocolFromModules, type ProtocolError } from './extract-protocol-ast.js';
import { loadTypeScript } from './load-typescript.js';

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

/** Extract the protocol manifest for the app whose sources live in `srcDir`. */
export async function extractProtocolFromDir(srcDir: string): Promise<DirExtraction> {
  const ts = await loadTypeScript();

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
      const result = extractProtocolFromModules(ts, entry, readFile);
      // A register() that was found and rejected must not fall through to the
      // next candidate: that would hide the very failure the errors describe.
      if (result.protocol || result.errors.length > 0) {
        return { protocol: result.protocol, warnings: [], errors: result.errors, degraded: false };
      }
    }
    return { protocol: null, warnings: [], errors: [], degraded: false };
  }

  // A file that produced warnings but no protocol still wins over the next
  // file: warnings mean a register() call was found and choked, and falling
  // through would hide exactly the truncation the diagnostics exist to surface.
  for (const file of ENTRY_FILES) {
    try {
      const source = await Bun.file(join(srcDir, file)).text();
      const extraction = extractProtocolWithDiagnostics(source);
      if (extraction.protocol || extraction.warnings.length > 0) {
        return { ...extraction, errors: [], degraded: true };
      }
    } catch {
      continue;
    }
  }
  return { protocol: null, warnings: [], errors: [], degraded: true };
}
