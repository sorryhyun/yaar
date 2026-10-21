/**
 * The source-guard pipeline for one app file, shared by the bundler plugin and the
 * project scan.
 *
 * Both run the same steps — cheap text gates, the closing-tag rewrite, one parse,
 * the solid-html and mount scanners — and differ only in what they do with the
 * findings: the plugin throws a compile error, `scanProjectGuards` renders tsc-style
 * diagnostic lines. Keeping the steps here is what keeps the two from drifting,
 * which matters because a project scan that disagrees with the build reports
 * findings the build never raises (or misses ones it does).
 */

import { loadTypeScript } from '../load-typescript.js';
import { createAppSourceFile } from './guard-report.js';
import { rewriteHtmlClosingTagsParsed } from './html-closing-tags.js';
import { scanMountTargetsIn, type MountFinding } from './mount-guard.js';
import { scanSourceFile, type SolidHtmlFinding } from './solid-html-guard.js';

export interface AppGuardScan {
  /** The source after the closing-tag rewrite — what the bundler should load. */
  text: string;
  /** Broken `html` templates; empty when the file has none or `typescript` is absent. */
  templates: SolidHtmlFinding[];
  /** `render()` calls into an element the wrapper never emits; empty likewise. */
  mounts: MountFinding[];
}

/**
 * Rewrite and scan one app source file.
 *
 * The text gates (`html\`` / `render(`) run before anything else, so `typescript`
 * is only loaded and the parser only runs on files that could match. With no
 * `typescript` (bundled-exe mode) the guards are skipped but the closing-tag
 * rewrite still runs.
 */
export async function scanAppGuards(fileName: string, text: string): Promise<AppGuardScan> {
  const mayHaveTemplates = text.includes('html`');
  const mayMount = text.includes('render(');
  if (!mayHaveTemplates && !mayMount) return { text, templates: [], mounts: [] };

  const ts = await loadTypeScript();
  // The rewrite runs before the scan: without it a legal `</${Component}>` parses
  // as junk and reports a finding the build never raises.
  const rewrite = rewriteHtmlClosingTagsParsed(ts, fileName, text);
  if (!ts) return { text: rewrite.text, templates: [], mounts: [] };

  // One parse for both guards in the common case: the rewrite's own parse is
  // reused when it changed nothing.
  const sf = rewrite.sourceFile ?? createAppSourceFile(ts, fileName, rewrite.text);
  return {
    text: rewrite.text,
    templates: mayHaveTemplates ? scanSourceFile(ts, sf) : [],
    mounts: mayMount ? scanMountTargetsIn(ts, sf) : [],
  };
}
