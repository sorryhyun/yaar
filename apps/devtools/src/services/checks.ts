export {};
import { errMsg } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
import { activeProject, files } from '../core';
import { isGeneratedPath } from '../lib/paths';
import {
  cssClassReport,
  findStaleFileRefs,
  type CssClassReport,
  type StaleFileRef,
} from '../lib/source-scan';
import { readFileText } from './files';

// Static checks over the active project's text that neither the type checker nor the
// bundler makes: comments and docs naming source files that are gone, and CSS classes
// that are defined but never named, or named but never styled.

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
const MAX_LISTED = 40;

export interface ProjectCheck {
  staleFileRefs: StaleFileRef[];
  css: CssClassReport;
  /** Entries past the per-list cap, by list. */
  omitted?: Record<string, number>;
  /** Why the SDK class list was unavailable, when `unknownSdk` could not be checked. */
  sdkNote?: string;
}

let sdkClassCache: string[] | null = null;

/** The `y-*` classes the design tokens define, read once per session. */
async function sdkClasses(): Promise<{ list: string[]; error?: string }> {
  if (sdkClassCache) return { list: sdkClassCache };
  try {
    const raw = JSON.stringify(await bundledLibraries('design-tokens'));
    const list = [...new Set(raw.match(/(?<![\w-])y-[a-z][\w-]*/g) ?? [])];
    if (list.length > 0) sdkClassCache = list;
    return { list };
  } catch (err) {
    return { list: [], error: errMsg(err) };
  }
}

export async function checkProject(): Promise<ProjectCheck> {
  if (!activeProject()) throw new Error('No active project. Open or create one first.');
  const entries = files().filter((f) => !f.isDirectory && !isGeneratedPath(f.path));
  const paths = entries.map((f) => f.path);
  const wanted = paths.filter((p) => SOURCE_EXT.test(p) || p.endsWith('.css') || p.endsWith('.md'));
  const texts = await Promise.all(
    wanted.map(async (path) => ({ path, text: (await readFileText(path)) ?? '' })),
  );
  const sdk = await sdkClasses();
  const staleFileRefs = findStaleFileRefs(texts, paths);
  const css = cssClassReport(
    texts.filter((t) => t.path.endsWith('.css')),
    texts.filter((t) => SOURCE_EXT.test(t.path)),
    sdk.list,
  );
  const omitted: Record<string, number> = {};
  const cap = <T,>(name: string, list: T[]): T[] => {
    if (list.length > MAX_LISTED) omitted[name] = list.length - MAX_LISTED;
    return list.slice(0, MAX_LISTED);
  };
  return {
    staleFileRefs: cap('staleFileRefs', staleFileRefs),
    css: {
      unused: cap('unused', css.unused),
      unstyled: cap('unstyled', css.unstyled),
      unknownSdk: cap('unknownSdk', css.unknownSdk),
    },
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(sdk.list.length === 0
      ? {
          sdkNote: `y-* classes were not checked: ${sdk.error ?? 'the design-token list had none'}`,
        }
      : {}),
  };
}

/** One line per non-empty finding, for a result that only points at `checkProject`. */
export function summarizeCheck(check: ProjectCheck): string[] {
  const lines: string[] = [];
  if (check.staleFileRefs.length) {
    lines.push(
      `${check.staleFileRefs.length} comment/doc reference(s) to source files that do not exist`,
    );
  }
  if (check.css.unknownSdk.length) {
    lines.push(`${check.css.unknownSdk.length} y-* class(es) that the SDK does not define`);
  }
  if (check.css.unstyled.length)
    lines.push(`${check.css.unstyled.length} class(es) used with no CSS rule`);
  if (check.css.unused.length) lines.push(`${check.css.unused.length} CSS class(es) nothing names`);
  return lines;
}
