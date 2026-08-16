/**
 * Run the source guards over a project directory, ahead of a build.
 *
 * The guards themselves live in the bundler plugin (`bundled/plugins.ts`), inside
 * `build.onLoad` — which only fires when Bun actually bundles a file, i.e. during
 * `compile`. That is late: an agent writes two files, saves both, and only then
 * learns that both broke the same rule, so it re-opens both and re-reasons about
 * the rule twice. The check is purely syntactic — the top-level node of an `html`
 * template, the id passed to `render` — so it needs no type information and no
 * bundle, and it can run against the files as they sit on disk.
 *
 * This is that run, shaped for `typecheckSandbox`: the same findings, rendered in
 * tsc's `path(line,col): error CODE: message` form so every existing consumer of
 * a diagnostics list (devtools' diagnostics panel, deploy's refusal, the agent
 * reading `typecheck()`) shows them without new plumbing.
 */

import { readdir, readFile } from 'fs/promises';
import { join, relative, sep } from 'path';
import { loadTypeScript } from '../load-typescript.js';
import { createAppSourceFile } from './guard-report.js';
import { scanSourceFile } from './solid-html-guard.js';
import { scanMountTargetsIn, APP_MOUNT_ID } from './mount-guard.js';

/** Diagnostic codes, in tsc's `error <CODE>:` slot. `\w+` only — consumers parse it. */
const SOLID_HTML_CODE = 'YAAR_HTML';
const MOUNT_CODE = 'YAAR_MOUNT';

/** Directories no app source lives in, and that would cost a deep walk to enter. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

async function sourceFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // No src/ dir, or unreadable — nothing to say about it here.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Scan `sandboxPath/src` and return tsc-formatted diagnostic lines, empty when
 * the project is clean.
 *
 * Silent — not an error — when `typescript` is unavailable (bundled-exe mode),
 * matching what the plugin does in the same environment.
 */
export async function scanProjectGuards(sandboxPath: string): Promise<string[]> {
  const ts = await loadTypeScript();
  if (!ts) return [];

  const srcDir = join(sandboxPath, 'src');
  const files = await sourceFilesUnder(srcDir);
  const diagnostics: string[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    // The same cheap text gates the plugin uses, so the parser only runs on files
    // that could possibly match.
    const mayHaveTemplates = text.includes('html`');
    const mayMount = text.includes('render(');
    if (!mayHaveTemplates && !mayMount) continue;

    // The plugin rewrites `</${Component}>` to `</>` before parsing; without the
    // same rewrite a legal closing tag parses as junk and reports a finding the
    // build never raises.
    const rewritten = text.replace(/<\/\$\{([^}]+)\}>/g, '</>');
    const rel = relative(sandboxPath, file).split(sep).join('/');
    const sf = createAppSourceFile(ts, rel, rewritten);

    if (mayHaveTemplates) {
      for (const f of scanSourceFile(ts, sf)) {
        diagnostics.push(
          `${rel}(${f.line},${f.column}): error ${SOLID_HTML_CODE}: ${f.problem}. Fix: ${f.fix}`,
        );
      }
    }
    if (mayMount) {
      for (const f of scanMountTargetsIn(ts, sf)) {
        diagnostics.push(
          `${rel}(${f.line},${f.column}): error ${MOUNT_CODE}: ${f.snippet} mounts into "${f.id}", ` +
            `which the app wrapper never emits. Fix: render into "${APP_MOUNT_ID}".`,
        );
      }
    }
  }

  return diagnostics;
}
