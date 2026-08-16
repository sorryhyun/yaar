/**
 * Prettier, as a pure function over one file's text.
 *
 * Dev Tools projects live under `storage/`, which `.prettierignore` excludes and no
 * repo script globs — so code an agent writes there is formatted by nothing, and
 * deploys it into `apps/` exactly as the model emitted it. This is the server half
 * of closing that: text in, text out.
 *
 * It deliberately does **not** touch the project directory. Dev Tools owns its own
 * write path (`services/files.ts`), and every write there records a diff, updates the
 * open editor buffer and refreshes the file list. A formatter that rewrote files on
 * disk behind that would leave all three describing bytes that no longer exist —
 * so the app reads, asks here, and writes the answer through the path it already has.
 *
 * `prettier/standalone` plus explicit plugins, rather than the main `prettier` entry:
 * the main entry resolves plugins through computed dynamic imports, which the
 * standalone-exe bundler cannot follow, and would leave every format in a shipped
 * build failing at the first parse. These four specifiers are literal, so Bun embeds
 * them. A prettier-less install (it is a devDependency) degrades to a stated refusal.
 */

import { join } from 'path';
import type { Options, Plugin } from 'prettier';
import { PROJECT_ROOT } from '../../config.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('DevFormat');

/** Parsers this serves, by extension. Anything else is refused by name, not guessed at. */
const PARSERS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'babel',
  jsx: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  json: 'json',
  css: 'css',
};

export const FORMATTABLE_EXTENSIONS = Object.keys(PARSERS);

/**
 * The repo's own `.prettierrc`, read once, falling back to its current values.
 *
 * The fallback is not a second style — it is what a standalone exe (which carries no
 * repo) has to use, and a project formatted there must come out matching a project
 * formatted here. A drift between the two would only surface as a diff on the deploy.
 */
const FALLBACK_OPTIONS: Options = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  tabWidth: 2,
  printWidth: 100,
};

let configCache: Options | undefined;

async function repoOptions(): Promise<Options> {
  if (configCache !== undefined) return configCache;
  try {
    const text = await Bun.file(join(PROJECT_ROOT, '.prettierrc')).text();
    configCache = { ...FALLBACK_OPTIONS, ...(JSON.parse(text) as Options) };
  } catch {
    configCache = FALLBACK_OPTIONS;
  }
  return configCache;
}

interface PrettierBundle {
  format: (source: string, options: Options) => Promise<string>;
  plugins: Plugin[];
}

let prettierCache: PrettierBundle | null | undefined;

/**
 * Load prettier, or null when it is unavailable.
 *
 * Memoized including the failure, for the reason `load-typescript.ts` memoizes its
 * own: a missing module does not become present later, and retrying costs a rejected
 * import per file in a format-the-project run.
 */
async function loadPrettier(): Promise<PrettierBundle | null> {
  if (prettierCache !== undefined) return prettierCache;
  try {
    const [standalone, estree, typescript, babel, postcss] = await Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/estree'),
      import('prettier/plugins/typescript'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/postcss'),
    ]);
    prettierCache = {
      format: standalone.format,
      plugins: [estree, typescript, babel, postcss] as unknown as Plugin[],
    };
  } catch (err) {
    log.warn('prettier unavailable', { detail: err instanceof Error ? err.message : String(err) });
    prettierCache = null;
  }
  return prettierCache;
}

export type FormatResult =
  | { ok: true; formatted: string; changed: boolean }
  /**
   * `kind` separates the three refusals a caller has to tell apart: an extension
   * nobody formats, a build without prettier in it, and code prettier could not
   * parse. Only the last is about the file.
   */
  | { ok: false; kind: 'unsupported' | 'unavailable' | 'parse'; reason: string };

/** The parser for a path, or null when nothing here formats that extension. */
export function parserFor(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return PARSERS[ext] ?? null;
}

/**
 * Format one file's text.
 *
 * `filePath` is read for its extension only — no file is opened, and the path never
 * reaches disk.
 */
export async function formatSource(source: string, filePath: string): Promise<FormatResult> {
  const parser = parserFor(filePath);
  if (!parser) {
    return {
      ok: false,
      kind: 'unsupported',
      reason: `No formatter for "${filePath}". Formattable: ${FORMATTABLE_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`,
    };
  }

  const prettier = await loadPrettier();
  if (!prettier) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'Formatting is unavailable in this build — prettier is not installed.',
    };
  }

  try {
    const formatted = await prettier.format(source, {
      ...(await repoOptions()),
      parser,
      plugins: prettier.plugins,
    });
    return { ok: true, formatted, changed: formatted !== source };
  } catch (err) {
    // A syntax error is the normal answer for half-written code, and the message
    // carries the line — it is the whole value of the failure, so it is passed
    // through rather than replaced with "could not format".
    return {
      ok: false,
      kind: 'parse',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
