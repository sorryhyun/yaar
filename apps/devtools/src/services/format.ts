export {};
import { appStorage, errMsg } from '@bundled/yaar';
import { format as devFormat } from '@bundled/yaar-dev';
import { activeProject, files, setStatusText } from '../core';
import { projectPath, isBinaryPath } from '../lib/paths';
import { changedLineRanges, formatLineRanges, diffStats } from '../lib/diff';
import { refreshFiles, writeFile } from './files';

// Prettier over the project's source, through the host's own formatter.
//
// The server formats text and returns text (POST /api/dev/format) — it never opens
// a file here. Writes go back through writeFile, so a format lands in the change
// history and the open editor buffer like any other edit, and the Changes panel
// shows exactly what it did.

/**
 * Extensions formatted here — the host's parser table minus JSON.
 *
 * JSON is deliberately absent. Storage reads a `.json` file back *parsed*, so the text
 * this app can hand a formatter is a re-serialization, not the bytes on disk: every run
 * would report a change, rewrite the file, and record a diff whose "before" was never
 * what the file held. A formatter that cannot see the file it is formatting has nothing
 * truthful to say about it. `app.json` is written by deploy, not by hand, so nothing is
 * lost. The endpoint itself still formats JSON for a caller holding real text.
 */
const FORMATTABLE = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css']);

export function isFormattable(path: string): boolean {
  if (isBinaryPath(path)) return false;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return FORMATTABLE.has(ext);
}

export interface FormattedFile {
  path: string;
  /**
   * Where the file changed, as line ranges in the **formatted** file: `12, 40-44`.
   *
   * Not the diff itself — the Changes panel already holds that, and a caller asking
   * for a tidy-up does not want the text back. What it cannot get anywhere else is
   * the scale and the location: one reflowed line reads very differently from a
   * hundred, and the numbers are the ones a following read or edit will see.
   */
  lines: string;
  added: number;
  removed: number;
}

export interface FormatOutcome {
  /** Files rewritten, with where each changed. */
  formatted: FormattedFile[];
  /** Files already formatted — read, checked, left alone. */
  unchanged: number;
  /** Files the formatter refused, each with why. */
  skipped: { path: string; reason: string }[];
}

/**
 * Format files in the active project.
 *
 * With no paths, every formattable file in the project — the file list already
 * excludes `dist/`, so generated output is never rewritten. A file prettier cannot
 * parse is skipped with its parse error rather than failing the run: half-written
 * code is the normal state of a project mid-edit, and one bad file must not stop
 * the other twenty from being tidied.
 */
export async function formatFiles(paths?: string[]): Promise<FormatOutcome> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project. Open or create one first.');

  if (files().length === 0) await refreshFiles(proj.id);

  const targets = paths?.length
    ? paths
    : files()
        .filter((f) => !f.isDirectory && isFormattable(f.path))
        .map((f) => f.path);

  const outcome: FormatOutcome = { formatted: [], unchanged: 0, skipped: [] };
  // An explicit path that formats nothing is a mistake worth naming; the same file
  // reached by the sweep was simply never a candidate, so it is filtered out above
  // rather than reported as a skip.
  for (const path of targets) {
    if (!isFormattable(path)) {
      outcome.skipped.push({ path, reason: 'No formatter for this file type.' });
      continue;
    }

    let content: string;
    try {
      content = await appStorage.read(projectPath(proj.id, path));
    } catch (err) {
      outcome.skipped.push({ path, reason: errMsg(err) });
      continue;
    }

    const result = await devFormat(path, content);
    if (!result.success || result.formatted === undefined) {
      outcome.skipped.push({ path, reason: result.error ?? 'Formatting failed.' });
      continue;
    }
    if (!result.changed) {
      outcome.unchanged += 1;
      continue;
    }

    await writeFile(path, result.formatted, {
      before: content,
      label: 'format',
      // One refresh at the end covers the whole batch.
      deferRefresh: true,
    });
    outcome.formatted.push({
      path,
      lines: formatLineRanges(changedLineRanges(content, result.formatted)),
      ...diffStats(content, result.formatted),
    });
  }

  if (outcome.formatted.length > 0) await refreshFiles(proj.id);
  setStatusText(
    outcome.formatted.length > 0
      ? `Formatted ${outcome.formatted.length} file${outcome.formatted.length === 1 ? '' : 's'}`
      : 'Already formatted',
  );
  return outcome;
}
