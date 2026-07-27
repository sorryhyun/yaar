/**
 * One compile, one read of each source file.
 *
 * Three passes over an app's `src/` used to each read it from disk in full: the
 * design-token guard (every `.ts`/`.tsx`/`.css`), the bundler's `onLoad` (every
 * reachable `.ts`/`.tsx`), and protocol extraction (every module-shaped file).
 * Overlapping extension sets, same directory, three reads.
 *
 * The cache is keyed by absolute forward-slash path, which is the one spelling
 * all three can agree on — the guards and the extractor build it from `srcDir`,
 * and the bundler normalizes what Bun hands its hook. A miss is always safe: it
 * reads the file and remembers it, so a caller that never got a cache behaves
 * exactly as it did before.
 *
 * **It must not outlive one compile.** `dev.ts` recompiles the same path over
 * and over, and a cache that survived between compiles would hand the bundler
 * the previous edit's source — a stale build with every signal green. Create it
 * in `compileTypeScript` and let it fall out of scope with the call.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { toForwardSlash } from '../bundled/registry.js';

export class AppSourceCache {
  private readonly texts = new Map<string, string>();
  private relativePaths: string[] | null = null;
  readonly srcDir: string;

  constructor(srcDir: string) {
    this.srcDir = toForwardSlash(srcDir);
  }

  /**
   * Every file under `src/`, listed once. Dotfiles included: a `.theme.css`
   * still defines tokens and a dot-prefixed module still holds source.
   */
  private list(): string[] {
    if (this.relativePaths === null) {
      this.relativePaths = [
        ...new Bun.Glob('**/*').scanSync({ cwd: this.srcDir, onlyFiles: true, dot: true }),
      ];
    }
    return this.relativePaths;
  }

  /**
   * Every source file whose path matches `extensions`, keyed by app-relative
   * path (`src/foo.ts`) — the spelling an author recognizes in a diagnostic.
   *
   * Unreadable files are skipped rather than thrown on: the bundler reports a
   * broken file far better than a directory walk can.
   */
  collect(extensions: RegExp): Map<string, string> {
    const collected = new Map<string, string>();
    for (const rel of this.list()) {
      if (!extensions.test(rel)) continue;
      try {
        collected.set(toForwardSlash(join('src', rel)), this.readSync(join(this.srcDir, rel)));
      } catch {
        // Unreadable file — skip it; the bundler will say why.
      }
    }
    return collected;
  }

  /** The text at an absolute path, read at most once per compile. */
  async read(absPath: string): Promise<string> {
    const key = toForwardSlash(absPath);
    const cached = this.texts.get(key);
    if (cached !== undefined) return cached;
    const text = await Bun.file(key).text();
    this.texts.set(key, text);
    return text;
  }

  /** As `read`, for the callers that walk the directory synchronously. */
  readSync(absPath: string): string {
    const key = toForwardSlash(absPath);
    const cached = this.texts.get(key);
    if (cached !== undefined) return cached;
    const text = readFileSync(key, 'utf8');
    this.texts.set(key, text);
    return text;
  }
}

/** Read one file, through `cache` when there is one. */
export function readThrough(cache: AppSourceCache | undefined, absPath: string): Promise<string> {
  return cache ? cache.read(absPath) : Bun.file(toForwardSlash(absPath)).text();
}
