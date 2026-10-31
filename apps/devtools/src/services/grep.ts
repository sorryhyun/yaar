export {};
import { invoke } from '@bundled/yaar';
import { activeProject } from '../core';
import {
  clipMatchLine,
  GREP_MAX_CONTEXT,
  GREP_PAGE,
  globToRegExp,
  isGeneratedPath,
  projectPath,
  searchSources,
  type SourceFile,
  type SourceMatch,
} from '../lib';
import { readProjectBytes } from './files';
import { listAllFiles } from './fs-walk';

export type GrepMatch = SourceMatch;

export interface GrepResult {
  matches: GrepMatch[];
  /** Every match in scope, across pages. Absent with no project open. */
  total?: number;
  /** Matches exist past this page. */
  truncated?: boolean;
  /** The offset of the next page, when there is one. */
  nextOffset?: number;
  /** Hits the first pass dropped as generated output. */
  excluded?: number;
}

/** The project's text files in scope, read as bytes so line numbers are the file's own. */
async function textFiles(
  projectId: string,
  glob: string | undefined,
  includeBuilt: boolean,
): Promise<SourceFile[]> {
  const base = projectPath(projectId);
  const only = glob ? globToRegExp(glob) : null;
  const entries = await listAllFiles(base, base, { includeGenerated: includeBuilt });
  const paths = entries
    .filter((e) => !e.isDirectory && (includeBuilt || !isGeneratedPath(e.path)))
    .map((e) => e.path)
    .filter((path) => !only || only.test(path));
  const read = await Promise.all(
    paths.map(async (path) => {
      try {
        const file = await readProjectBytes(path);
        return file.encoding ? null : { path, content: file.content };
      } catch {
        return null;
      }
    }),
  );
  return read.filter((f): f is SourceFile => f !== null);
}

/**
 * Regex search across the active project, with generated output filtered out unless
 * `includeBuilt` asks for it.
 *
 * The storage grep is the fast path, and it has two limits this has to work around: it stops
 * at 100 hits and takes no exclusions, so its answer says neither how many there are nor
 * whether source matches sat behind a bundle's. A search it cut short, and any later page or
 * request for context lines, is answered by reading the files here with the same pattern
 * compiler. `excluded` counts the hits dropped as generated, which is what lets the caller
 * say "in generated output" rather than present a short result as a complete one.
 *
 * Each hit's line is cut to a window around the match (`clipMatchLine`): the storage
 * grep returns lines whole, and one fixture line can be thousands of characters.
 */
export async function grep(
  pattern: string,
  glob?: string,
  includeBuilt = false,
  page: { offset?: number; context?: number } = {},
): Promise<GrepResult> {
  const proj = activeProject();
  if (!proj) return { matches: [] };
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const context = Math.min(GREP_MAX_CONTEXT, Math.max(0, Math.floor(page.context ?? 0)));
  let excluded = 0;
  if (offset === 0 && context === 0) {
    const storagePath = `projects/${proj.id}`;
    const result = await invoke<{ matches: GrepMatch[]; truncated?: boolean }>(
      `yaar://apps/self/storage/${storagePath}`,
      { action: 'grep', pattern, ...(glob ? { glob } : {}) },
    );
    const matches = (result?.matches ?? []).map((m) => ({
      ...m,
      content: clipMatchLine(m.content, pattern),
    }));
    const kept = includeBuilt ? matches : matches.filter((m) => !isGeneratedPath(m.file));
    excluded = matches.length - kept.length;
    if (!result?.truncated) {
      return {
        matches: kept,
        total: kept.length,
        ...(excluded > 0 ? { excluded } : {}),
      };
    }
  }
  const files = await textFiles(proj.id, glob, includeBuilt);
  const { matches, total } = searchSources(files, pattern, undefined, GREP_PAGE, {
    offset,
    context,
  });
  const end = offset + matches.length;
  return {
    matches,
    total,
    ...(end < total ? { truncated: true, nextOffset: end } : {}),
    ...(excluded > 0 ? { excluded } : {}),
  };
}
