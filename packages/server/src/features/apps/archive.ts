/**
 * Unpack a marketplace app archive into a staging directory.
 *
 * What arrives is what `packageAppTarball` uploaded: a gzipped tar whose every entry is
 * prefixed with the app's directory name (`myapp/app.json`, `myapp/src/main.ts`). Installing
 * means dropping that first component — the job `tar --strip-components=1` did until
 * `Bun.Archive` retired the spawn, and with it a whole class of shell-shaped bugs (GNU tar
 * reads the colon in `C:\…\app.tar.gz` as remote `host:path` syntax and tries to reach a
 * machine called C, which is why the old invocation had to keep every path relative to cwd).
 * Both ends of the round trip are `Bun.Archive` now: `packageAppTarball` builds the archive
 * this function takes apart.
 *
 * Two things the spawn used to handle that are this function's job now:
 *
 *   - **Path safety.** `Archive.prototype.extract()` sanitizes entry names on its own — a
 *     `../escaped.txt` entry lands *inside* the destination — but it cannot strip a
 *     component, so entries are read through `files()` and written here. `files()` hands
 *     back the archive's **raw** names, leading `/` and `../` included. Anything that
 *     resolves outside the staging directory fails the install rather than being quietly
 *     clamped: a marketplace archive has no reason to contain one, so it is a signal, not
 *     a case to handle.
 *   - **What is not a regular file.** `files()` yields regular files only, so a symlink or
 *     device node in a hostile archive is dropped instead of recreated. An app is source
 *     text and has never needed either.
 *
 * One trap worth stating: `Bun.Archive` refuses a lazy `Bun.file()` — it reports
 * "Unrecognized archive format" for one — so it is handed materialized bytes. The caller
 * has them already, straight from the download, which is also why nothing writes the
 * tarball to disk any more.
 */

import { dirname, resolve, sep } from 'path';
import { mkdir } from 'fs/promises';

/** Drop the first path component, the way `tar --strip-components=1` does. */
function stripLeadingComponent(entry: string): string | null {
  const slash = entry.indexOf('/');
  // No separator means the entry *is* the stripped component, so nothing survives it —
  // the same thing tar does with a top-level file under `--strip-components=1`.
  return slash === -1 ? null : entry.slice(slash + 1);
}

/**
 * Extract `archive` into `into`, stripping one leading path component from every entry.
 *
 * Returns the number of files written. Throws on an entry that would escape `into`.
 */
export async function extractAppArchive(
  archive: Uint8Array,
  into: string,
): Promise<{ files: number }> {
  const entries = await new Bun.Archive(archive).files();
  const root = resolve(into);

  let written = 0;
  for (const [name, file] of entries) {
    const stripped = stripLeadingComponent(name);
    if (stripped === null || stripped === '') continue;

    const target = resolve(root, stripped);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`archive entry "${name}" points outside the app directory`);
    }

    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, file);
    written++;
  }

  if (written === 0) throw new Error('archive contained no files');
  return { files: written };
}
