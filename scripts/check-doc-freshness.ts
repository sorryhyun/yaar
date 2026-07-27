/**
 * Detect stale reference docs by comparing each doc against the source files
 * it points to.
 *
 * Reference docs in `docs/` declare their source of truth with lines like:
 *
 *     **Source:** `packages/shared/src/actions.ts`
 *     **Source:** `packages/server/src/storage/mounts.ts`, `packages/server/src/mcp/system/config-mounts.ts`
 *     **Source:** `packages/shared/src/capture-helper.ts` (`IFRAME_STORAGE_SDK_SCRIPT`)
 *
 * This script parses those pointers and, for each source file, asks git whether
 * it was changed in any commit *after* the doc's last commit. If so, the doc may
 * be out of date and is reported. It also flags pointers to files that no longer
 * exist (definitely wrong).
 *
 * Usage:
 *   bun run scripts/check-doc-freshness.ts            # check every markdown file under docs/
 *   bun run scripts/check-doc-freshness.ts docs/x.md  # check specific docs
 *   bun run scripts/check-doc-freshness.ts --quiet     # only print problems
 *   bun run scripts/check-doc-freshness.ts --strict    # fail on stale sources too
 *
 * Exit code: 1 for broken pointers or bundled-library list drift. Stale sources
 * are advisory unless --strict is passed, since a source file may change in a
 * way unrelated to the section a doc describes.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { BUNDLED_LIBRARIES } from '../packages/compiler/src/index.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const BUNDLED_LIBRARY_DOCS = [
  'CLAUDE.md',
  'packages/compiler/CLAUDE.md',
  'docs/guides/app-development.md',
  'docs/ko/app-development.md',
];

/** Section headings that introduce a prose list of `@bundled/*` imports, per locale. */
const BUNDLED_LIBRARY_HEADING = /^#{2,6}\s+.*(Bundled Libraries|번들 라이브러리)\s*$/;

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Last commit hash that touched a path (committed history only). '' if never committed. */
function lastCommitHash(path: string): string {
  return git(['log', '-1', '--format=%H', '--', path]);
}

/** True if the path has uncommitted (unstaged or staged) working-tree changes. */
function hasUncommittedChanges(path: string): boolean {
  return git(['status', '--porcelain', '--', path]).length > 0;
}

/** Commits that touched `src` strictly after `sinceHash` (newest first). */
function commitsSince(sinceHash: string, src: string): string[] {
  const range = sinceHash ? `${sinceHash}..HEAD` : 'HEAD';
  const out = git(['log', '--format=%h %ad %s', '--date=short', range, '--', src]);
  return out ? out.split('\n') : [];
}

/**
 * Extract source file paths from the `**Source:**` lines of a doc.
 * Keeps only backtick-quoted tokens that resolve to a real file on disk, which
 * naturally drops trailing symbol references like (`IFRAME_STORAGE_SDK_SCRIPT`).
 * Returns both the resolved (existing) paths and any missing (broken) pointers
 * that look like file paths but don't exist.
 */
function parseSources(docText: string): { valid: string[]; broken: string[] } {
  const valid = new Set<string>();
  const broken = new Set<string>();
  const looksLikePath = /^[\w./@-]+\.[\w]+$/; // has a dir/extension shape, no spaces

  for (const line of docText.split('\n')) {
    if (!line.includes('**Source:**')) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const token = m[1].trim();
      if (existsSync(resolve(REPO_ROOT, token))) {
        valid.add(token);
      } else if (looksLikePath.test(token) && token.includes('/')) {
        broken.add(token);
      }
    }
  }
  return { valid: [...valid], broken: [...broken] };
}

/** Extract @bundled/* import names from a doc's Bundled Libraries section. */
function parseDocumentedBundledLibraries(docText: string): Set<string> | null {
  const lines = docText.split('\n');
  const start = lines.findIndex((line) => BUNDLED_LIBRARY_HEADING.test(line.trim()));
  if (start === -1) return null;

  const headingLevel = lines[start].match(/^#+/)![0].length;
  const endOffset = lines
    .slice(start + 1)
    .findIndex((line) => new RegExp(`^#{1,${headingLevel}}\\s`).test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  const section = lines.slice(start + 1, end).join('\n');
  const libraries = new Set<string>();
  for (const match of section.matchAll(/`@bundled\/([^`]+)`/g)) {
    if (match[1] !== '*') libraries.add(match[1]);
  }
  return libraries;
}

/** Ensure every prose library list exactly matches the compiler's import surface. */
function checkBundledLibraryDocs(quiet: boolean): number {
  const expected = new Set(Object.keys(BUNDLED_LIBRARIES));
  let problemCount = 0;

  for (const doc of BUNDLED_LIBRARY_DOCS) {
    const documented = parseDocumentedBundledLibraries(
      readFileSync(resolve(REPO_ROOT, doc), 'utf8'),
    );
    if (!documented) {
      console.error(`❌ ${doc}: missing a Bundled Libraries section`);
      problemCount++;
      continue;
    }

    const missing = [...expected].filter((name) => !documented.has(name)).sort();
    const unexpected = [...documented].filter((name) => !expected.has(name)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      console.error(`❌ ${doc}: bundled-library list differs from BUNDLED_LIBRARIES:`);
      if (missing.length > 0) console.error(`     missing: ${missing.join(', ')}`);
      if (unexpected.length > 0) console.error(`     unexpected: ${unexpected.join(', ')}`);
      problemCount++;
    } else if (!quiet) {
      console.log(`✅ ${doc}: bundled-library list is current (${expected.size} imports)`);
    }
  }

  return problemCount;
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const quiet = rawArgs.includes('--quiet');
  const strict = rawArgs.includes('--strict');
  const fileArgs = rawArgs.filter((a) => !a.startsWith('--'));

  const docs =
    fileArgs.length > 0
      ? fileArgs.map((f) => relative(REPO_ROOT, resolve(f)))
      : git(['ls-files', 'docs/*.md', 'docs/**/*.md']).split('\n').filter(Boolean);

  let staleCount = 0;
  let brokenCount = 0;
  const bundledLibraryDocProblems = checkBundledLibraryDocs(quiet);

  for (const doc of docs) {
    const absDoc = resolve(REPO_ROOT, doc);
    if (!existsSync(absDoc)) {
      console.error(`⚠️  ${doc}: file not found`);
      brokenCount++;
      continue;
    }

    const { valid, broken } = parseSources(readFileSync(absDoc, 'utf8'));
    if (valid.length === 0 && broken.length === 0) {
      if (!quiet) console.log(`•  ${doc}: no **Source:** pointers (not tracked)`);
      continue;
    }

    // A doc being actively edited (uncommitted changes) is presumed up to date —
    // don't nag mid-fix. Broken-pointer checks below still run on the working tree.
    const docHash = lastCommitHash(doc);
    const staleSources: { src: string; commits: string[] }[] = [];
    if (!hasUncommittedChanges(doc)) {
      for (const src of valid) {
        const commits = commitsSince(docHash, src);
        if (commits.length > 0) staleSources.push({ src, commits });
      }
    }

    if (broken.length > 0) {
      brokenCount += broken.length;
      console.error(`❌ ${doc}: broken **Source:** pointer(s):`);
      for (const b of broken) console.error(`     ${b} (no such file)`);
    }

    if (staleSources.length > 0) {
      staleCount++;
      console.error(
        `⚠️  ${doc}: source changed since doc's last update (${docHash.slice(0, 7) || 'uncommitted'}):`,
      );
      for (const { src, commits } of staleSources) {
        console.error(`     ${src}`);
        for (const c of commits) console.error(`       · ${c}`);
      }
    } else if (broken.length === 0 && !quiet) {
      console.log(`✅ ${doc}: fresh (${valid.length} source${valid.length === 1 ? '' : 's'})`);
    }
  }

  const problems = brokenCount + bundledLibraryDocProblems + (strict ? staleCount : 0);
  if (problems > 0) {
    console.error(
      `\n${staleCount} stale doc warning(s), ${brokenCount} broken pointer(s). ` +
        `${bundledLibraryDocProblems} bundled-library list problem(s). ` +
        `${strict ? 'Strict mode requires stale docs to be reviewed. ' : ''}` +
        `Update the doc(s) above, or move the **Source:** pointer if the code moved.`,
    );
    process.exit(1);
  }
  if (!quiet) {
    if (staleCount > 0) {
      console.log(`\nRequired doc checks passed (${staleCount} stale doc warning(s)).`);
    } else {
      console.log('\nAll docs fresh.');
    }
  }
}

main();
