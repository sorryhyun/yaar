/**
 * Auto-compile stale apps at server startup.
 *
 * Scans apps/ for directories with src/main.ts, checks each against
 * its build manifest, and recompiles any that have changed.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { compileTypeScript, isAppStale } from '@yaar/compiler';
import { APP_ROOTS } from './roots.js';
import { invalidateAppsCache } from './discovery.js';

const CONCURRENCY = 4;

interface AutoCompileResult {
  compiled: string[];
  skipped: string[];
  failed: { appId: string; errors: string[] }[];
}

export interface AutoCompileOptions {
  /**
   * Compile only these app ids. An id matching no app is a failure, not a
   * silent no-op — a typo'd id would otherwise report "0 failed" and look
   * like a clean build of the app you meant.
   */
  only?: string[];
  /**
   * Compile regardless of the build manifest. Naming apps explicitly implies
   * this: you asked for *this* app, and "skipped, unchanged" is the wrong
   * answer when what changed is something the source hash does not cover.
   */
  force?: boolean;
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;
  async function next(): Promise<void> {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

export async function autoCompileApps(
  options: AutoCompileOptions = {},
): Promise<AutoCompileResult> {
  const result: AutoCompileResult = { compiled: [], skipped: [], failed: [] };
  const only = options.only?.length ? new Set(options.only) : null;

  // Find apps with src/main.ts across all roots (bundled wins on id collision).
  const appDirs: { appId: string; appPath: string }[] = [];
  const seen = new Set<string>();
  for (const root of APP_ROOTS) {
    let dirNames: string[];
    try {
      dirNames = await readdir(root);
    } catch {
      continue; // root doesn't exist
    }
    for (const name of dirNames) {
      if (seen.has(name)) continue;
      const appPath = join(root, name);
      try {
        const s = await stat(appPath);
        if (!s.isDirectory()) continue;
        await stat(join(appPath, 'src', 'main.ts'));
        seen.add(name);
        appDirs.push({ appId: name, appPath });
      } catch {
        // Not a directory or no src/main.ts
      }
    }
  }

  if (only) {
    for (const appId of only) {
      if (!appDirs.some((d) => d.appId === appId)) {
        const known = appDirs
          .map((d) => d.appId)
          .sort()
          .join(', ');
        result.failed.push({ appId, errors: [`no app with src/main.ts. Known: ${known}`] });
      }
    }
    if (result.failed.length > 0) return result;
  }

  const selected = only ? appDirs.filter((d) => only.has(d.appId)) : appDirs;
  if (selected.length === 0) return result;

  // Check staleness and compile
  const tasks = selected.map(({ appId, appPath }) => async () => {
    try {
      const stale = options.force || (await isAppStale(appPath));
      if (!stale) {
        result.skipped.push(appId);
        return;
      }

      // Read app.json for compile options
      let bundles: string[] | undefined;
      let title = appId;
      try {
        const meta = JSON.parse(await Bun.file(join(appPath, 'app.json')).text());
        if (Array.isArray(meta.bundles)) bundles = meta.bundles;
        if (typeof meta.name === 'string') title = meta.name;
      } catch {
        // No app.json
      }

      const compileResult = await compileTypeScript(appPath, { title, bundles });
      if (compileResult.success) {
        result.compiled.push(appId);
      } else {
        result.failed.push({ appId, errors: compileResult.errors ?? ['Unknown error'] });
      }
    } catch (err) {
      result.failed.push({ appId, errors: [String(err)] });
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);
  // Freshly-built dist/ changes what listApps() reports (isCompiled, protocol).
  // With boot now serving before compile finishes, drop any listing cached
  // mid-compile so the next scan reflects the new builds.
  if (result.compiled.length > 0) invalidateAppsCache();
  return result;
}
