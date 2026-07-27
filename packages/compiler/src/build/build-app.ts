/**
 * The one place that spells "bundle a YAAR app with Bun".
 *
 * Two callers build an app: `compile.ts` (the real build) and `fold-schemas.ts`
 * (a throwaway build whose only job is to run the app and read its schemas back).
 * They must resolve imports *identically* — a `@bundled/*` specifier the fold
 * resolves differently is an app that passes one and fails the other — and the
 * only way to hold that is for the plugin list to exist once rather than be kept
 * in sync by hand.
 */

import {
  bundledLibraryPluginBun,
  cssFilePlugin,
  assetDataUrlPlugin,
  solidHtmlSourcePlugin,
} from '../bundled/plugins.js';
import { toForwardSlash } from '../bundled/registry.js';
import type { AppSourceCache } from './source-cache.js';

export interface AppBuildOptions {
  /**
   * The real build minifies; the fold deliberately does not — that bundle is
   * never shipped, and a readable stack is the difference between "the app
   * threw" and knowing where.
   */
  minify: boolean;
  /** `app.json`'s `bundles`, gating the `@bundled/yaar-*` SDKs. */
  bundles?: string[];
  /**
   * The compile's source cache, so the solid-html hook reads a file the token
   * guard already read from memory. Absent — as in the fold's throwaway build,
   * which bundles a generated entry — every read goes to disk as before.
   */
  sources?: AppSourceCache;
}

/** Bundle an app entry point. Resolves on failure too — inspect `.success`. */
export async function buildAppBundle(
  entryPoint: string,
  options: AppBuildOptions,
): Promise<Bun.BuildOutput> {
  return Bun.build({
    entrypoints: [toForwardSlash(entryPoint)],
    minify: options.minify,
    format: 'esm',
    target: 'browser',
    // Resolve with { success: false, logs } instead of throwing, so errors
    // keep their file/line/column positions (the catch path loses them).
    throw: false,
    plugins: [
      bundledLibraryPluginBun(options.bundles),
      cssFilePlugin(),
      assetDataUrlPlugin(),
      solidHtmlSourcePlugin(options.sources),
    ],
  });
}

export interface BuildLogOptions {
  /** Also report `warning` logs, which a failed build can carry alone. */
  includeWarnings?: boolean;
  /**
   * Prefix `file:line:col:` when a log carries a position. `String(message)`
   * discards it, so only the caller that prints to a developer asks for it.
   */
  withPosition?: boolean;
  /** File to name when a positioned log does not name one itself. */
  fallbackFile?: string;
}

/** Reduce Bun's build logs to the failure messages a caller should report. */
export function formatBuildLogs(
  logs: Bun.BuildOutput['logs'],
  options: BuildLogOptions = {},
): string[] {
  return logs
    .filter((log) => log.level === 'error' || (options.includeWarnings && log.level === 'warning'))
    .map((log) => {
      const message = log.message || String(log);
      if (!options.withPosition) return message;
      const pos = log.position;
      return pos
        ? `${pos.file ?? options.fallbackFile}:${pos.line}:${pos.column}: ${message}`
        : message;
    });
}
