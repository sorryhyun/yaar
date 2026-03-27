/**
 * Auto-compile stale apps at server startup.
 *
 * Scans apps/ for directories with src/main.ts, checks each against
 * its build manifest, and recompiles any that have changed.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { compileTypeScript, isAppStale } from '@yaar/compiler';
import { PROJECT_ROOT } from '../../config.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');
const CONCURRENCY = 4;

interface AutoCompileResult {
  compiled: string[];
  skipped: string[];
  failed: { appId: string; errors: string[] }[];
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

export async function autoCompileApps(): Promise<AutoCompileResult> {
  const result: AutoCompileResult = { compiled: [], skipped: [], failed: [] };

  let dirNames: string[];
  try {
    dirNames = await readdir(APPS_DIR);
  } catch {
    return result; // apps/ doesn't exist
  }

  // Find apps with src/main.ts
  const appDirs: { appId: string; appPath: string }[] = [];
  for (const name of dirNames) {
    const appPath = join(APPS_DIR, name);
    try {
      const s = await stat(appPath);
      if (!s.isDirectory()) continue;
      await stat(join(appPath, 'src', 'main.ts'));
      appDirs.push({ appId: name, appPath });
    } catch {
      // Not a directory or no src/main.ts
    }
  }

  if (appDirs.length === 0) return result;

  // Check staleness and compile
  const tasks = appDirs.map(({ appId, appPath }) => async () => {
    try {
      const stale = await isAppStale(appPath);
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
  return result;
}
