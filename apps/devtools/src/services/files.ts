export {};
import { batch } from '@bundled/solid-js';
import { appStorage, blobToDataUrl, errMsg } from '@bundled/yaar';
import {
  activeProject,
  setActiveProject,
  setFiles,
  type FileEntry,
  openFilePath,
  setOpenFilePath,
  setOpenFileContent,
  setOpenFileImage,
  setStatusText,
  setTypecheckState,
} from '../core';
import { projectPath, isImagePath, isBinaryPath, relativizeProjectPaths } from '../lib/paths';
import { applyEdits, formatRemoved, type EditSpec } from '../lib/edits';
import { listAllFiles } from './fs-walk';
import { recordChange } from './changes';

// File I/O against the active project's sandbox: listing, reading, writing,
// editing, copying, deleting. The edit *algebra* lives in ../lib/edits — this
// module only supplies storage and the signals.

export async function refreshFiles(projectId?: string): Promise<void> {
  const id = projectId ?? activeProject()?.id;
  if (!id) return;
  const basePath = projectPath(id);
  try {
    const mapped = pruneEmptyDirectories(await listAllFiles(basePath, basePath));
    // Sizes and timestamps come from the listing itself. Line counts do not — those
    // need the text — so the `project` state can still answer "how big is this file"
    // without a read per file (agents used to read line 1 just to see the "(N lines)"
    // header). Projects are a handful of source files, so reading them in parallel
    // here is cheap; a file that cannot be read stays uncounted.
    await Promise.all(
      mapped.map(async (entry) => {
        if (entry.isDirectory || isBinaryPath(entry.path)) return;
        try {
          const raw = await appStorage.read(projectPath(id, entry.path));
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          entry.lines = text.split('\n').length;
          // Recomputed from the text: a JSON file read back parsed and re-serialized
          // is not byte-identical to what is on disk, and the count must match the
          // string this app would edit.
          entry.bytes = new TextEncoder().encode(text).length;
        } catch {
          /* unreadable — leave the listing's own size standing */
        }
      }),
    );
    setFiles(mapped);
    touchProjectModified(id, mapped);
  } catch {
    setFiles([]);
  }
}

/**
 * Drop directories that hold nothing.
 *
 * Storage is prefix-addressed, so removing a directory's last file leaves the
 * directory itself behind — `src/util/` stayed in the listing after both of its
 * files were deleted, reading as a place where something still lives. Nothing in a
 * project needs an empty directory: the next write to a path under it recreates it.
 */
function pruneEmptyDirectories(entries: FileEntry[]): FileEntry[] {
  const occupied = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const segments = entry.path.split('/');
    for (let i = 1; i < segments.length; i++) occupied.add(segments.slice(0, i).join('/'));
  }
  return entries.filter((e) => !e.isDirectory || occupied.has(e.path));
}

/**
 * Date the active project from its newest file.
 *
 * Storage has no timestamp for a *directory* that would mean "anything under it
 * changed", so the project's own time is the max over its files — which is the
 * definition the question wants anyway.
 */
function touchProjectModified(projectId: string, entries: FileEntry[]): void {
  const active = activeProject();
  if (!active || active.id !== projectId) return;
  let newest = 0;
  for (const entry of entries) {
    if (!entry.modifiedAt) continue;
    const ms = Date.parse(entry.modifiedAt);
    if (!Number.isNaN(ms) && ms > newest) newest = ms;
  }
  if (newest !== active.lastModified) setActiveProject({ ...active, lastModified: newest });
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/**
 * An image file's raw base64 plus its MIME type, or null if it could not be read as
 * bytes. Shared by the editor (which builds a data URL) and the `readFile` command
 * (which returns an image content block), so both agree on how an image is decoded.
 */
export async function readImageFile(
  path: string,
): Promise<{ data: string; mimeType: string } | null> {
  const proj = activeProject();
  if (!proj) return null;
  try {
    const { data, mimeType, encoding } = await appStorage.readBinary(projectPath(proj.id, path));
    if (encoding !== 'base64') return null;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mime =
      mimeType && mimeType !== 'application/octet-stream'
        ? mimeType
        : (IMAGE_MIME[ext] ?? 'application/octet-stream');
    return { data, mimeType: mime };
  } catch {
    return null;
  }
}

export async function openFile(path: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  if (isImagePath(path)) {
    // Reading an image as text yields a wall of base64 (or mojibake). Read the bytes
    // and hand the editor a data URL instead.
    const image = await readImageFile(path);
    if (image) {
      batch(() => {
        setOpenFilePath(path);
        setOpenFileContent(null);
        setOpenFileImage(`data:${image.mimeType};base64,${image.data}`);
      });
      return;
    }
    // Unreadable as bytes — fall through to the text path, which reports the failure.
  }
  try {
    const content = await appStorage.read(projectPath(proj.id, path));
    batch(() => {
      setOpenFilePath(path);
      setOpenFileImage(null);
      setOpenFileContent(typeof content === 'string' ? content : JSON.stringify(content));
    });
  } catch {
    batch(() => {
      setOpenFilePath(path);
      setOpenFileImage(null);
      setOpenFileContent(`// Could not read ${path}`);
    });
  }
}

/**
 * A file's current text, or null when there is nothing there to read.
 *
 * Null is the create/update distinction: a failed read here means the path does
 * not exist yet, which the change history reports differently from overwriting a
 * file that happened to be empty. JSON is rendered the way readFile renders it so
 * the recorded "before" matches what a reader was shown.
 */
async function currentText(projectId: string, path: string): Promise<string | null> {
  try {
    const raw = await appStorage.read(projectPath(projectId, path));
    return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  } catch {
    return null;
  }
}

export interface WriteReceipt {
  path: string;
  lines: number;
  bytes: number;
}

/**
 * Write a file and say what landed.
 *
 * The receipt exists because `editFile` returns `{ editsApplied, lines, removed }`
 * and this returned "Done." — so the one command whose whole job is to replace a
 * file's contents was the one that would not confirm what the file now holds. A
 * line count is also the cheapest way to catch the mistake this command invites:
 * passing a JSON object and getting the serialization you did not expect.
 */
export async function writeFile(
  path: string,
  content: string,
  change?: {
    /**
     * The text this write replaces, when the caller already has it. `editFile` does
     * — re-reading here would fetch the bytes it just wrote in the same tick on a
     * slow store, and reading twice is wasted work regardless.
     */
    before?: string | null;
    /** How the change history labels this write. Defaults to 'write'. */
    label?: string;
  },
): Promise<WriteReceipt> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project. Open or create one first.');
  const before = change?.before !== undefined ? change.before : await currentText(proj.id, path);
  await appStorage.save(projectPath(proj.id, path), content);
  recordChange({
    path,
    kind: before === null ? 'create' : 'update',
    before: before ?? '',
    after: content,
    label: change?.label ?? 'write',
  });
  if (openFilePath() === path) setOpenFileContent(content);
  // Whatever tsc last concluded, it concluded about the previous bytes.
  setTypecheckState('unknown');
  await refreshFiles();
  setStatusText(`Saved ${path}`);
  return {
    path,
    lines: content.split('\n').length,
    bytes: new TextEncoder().encode(content).length,
  };
}

export async function editFile(
  path: string,
  edits: EditSpec[],
): Promise<{ editsApplied: number; lines: number; removed: string }> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project. Open or create one first.');
  if (edits.length === 0) throw new Error('No edits given');
  const raw = await appStorage.read(projectPath(proj.id, path));
  // JSON files can come back parsed — render them the way readFile does, so a
  // search string copied from a readFile result matches.
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const { content: updated, removals } = applyEdits(content, edits);
  await writeFile(path, updated, {
    before: content,
    label: edits.length > 1 ? `edit ×${edits.length}` : 'edit',
  });
  return {
    editsApplied: edits.length,
    lines: updated.split('\n').length,
    removed: formatRemoved(removals),
  };
}

/**
 * Read a source file for a copy, naming the path the caller used when it is missing.
 *
 * The storage error names the file by its real location
 * (`apps/devtools/projects/1786…/src/x.ts`), which is both unpastable — every input in
 * this protocol is project-relative — and a publication of where the sandbox lives on
 * the host.
 */
async function readCopyText(projectId: string, path: string): Promise<string> {
  try {
    const raw = await appStorage.read(projectPath(projectId, path));
    return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
}

/**
 * Copy a file's bytes, for the files that are not text.
 *
 * Reading one as text and writing the string back corrupted every image it touched, so
 * the bytes travel as bytes: `readBlob`, then `blobToDataUrl` for the base64 `save`
 * wants. Non-image binaries round-trip exactly this way.
 *
 * Images cannot, and no client-side read can fix it: **storage serves images re-encoded
 * to WebP**. A 408,746-byte PNG reads back as a 40,472-byte `image/webp` blob through
 * `readBinary` and `readBlob` alike. So an image copy yields WebP, and the destination
 * is renamed to match rather than left claiming to be a PNG.
 *
 * A server-side `action: 'copy'` would avoid the read entirely — it is how a storage
 * *import* stays byte-exact — but it cannot express this case. `from` does not expand
 * `self`, and an app's own storage is reachable by no other spelling: both
 * `yaar://apps/{id}/storage/` and `yaar://storage/apps/{id}/` are refused, the flat-root
 * grant deliberately excluding `apps/`.
 */
async function copyBytes(projectId: string, from: string, to: string): Promise<string> {
  try {
    const blob = await appStorage.readBlob(projectPath(projectId, from));
    // Storage serves images re-encoded to WebP, so a .png read back is WebP bytes and
    // writing them under the original name would produce a file whose contents and
    // extension disagree — the corruption this function exists to end, one layer up.
    // The destination follows the bytes instead, and the caller is told where it landed.
    const dest =
      isImagePath(from) && blob.type === 'image/webp' && !/\.webp$/i.test(to)
        ? to.replace(/\.[^.]+$/, '.webp')
        : to;
    const dataUrl = await blobToDataUrl(blob);
    await appStorage.save(projectPath(projectId, dest), dataUrl.slice(dataUrl.indexOf(',') + 1), {
      encoding: 'base64',
    });
    return dest;
  } catch (err) {
    // Keeps the server's reason, drops the host path it names it with.
    throw new Error(
      relativizeProjectPaths([`Could not copy ${from}: ${errMsg(err)}`], projectId)[0] ?? '',
    );
  }
}

/** Copies `from` to `to`, returning where it actually landed — see `copyBytes`. */
export async function copyFile(from: string, to: string): Promise<string> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project');

  // Text goes through writeFile, so a copy records a diff like any other write. It also
  // carries the typecheck reset and the file refresh: a copy is a new module in the
  // program, and an orphan still gets type checked.
  if (!isBinaryPath(from)) {
    await writeFile(to, await readCopyText(proj.id, from), { label: `copy from ${from}` });
    setStatusText(`Copied ${from} → ${to}`);
    return to;
  }

  // Binary cannot go through writeFile at all: it takes a string, and would record
  // mojibake as the diff. Recorded as the fact instead — the shape deleteFile already
  // uses to report removing one.
  const landed = await copyBytes(proj.id, from, to);
  recordChange({
    path: landed,
    kind: 'create',
    before: '',
    after: `(binary file copied from ${from})`,
    label: `copy from ${from}`,
  });
  setTypecheckState('unknown');
  await refreshFiles();
  setStatusText(`Copied ${from} → ${landed}`);
  return landed;
}

export async function deleteFile(path: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  // Bytes that are not text decode to mojibake, and a diff of mojibake tells the
  // reader nothing. Binary deletions are recorded as the fact, not as content.
  const before = isBinaryPath(path)
    ? `(binary file removed: ${path})`
    : await currentText(proj.id, path);
  await appStorage.remove(projectPath(proj.id, path));
  recordChange({
    path,
    kind: 'delete',
    before: before ?? '',
    after: '',
    label: 'delete',
  });
  if (openFilePath() === path) {
    batch(() => {
      setOpenFilePath(null);
      setOpenFileContent(null);
      setOpenFileImage(null);
    });
  }
  // Deleting a file is how an import breaks, so the last verdict no longer holds.
  setTypecheckState('unknown');
  await refreshFiles();
  setStatusText(`Deleted ${path}`);
}

export interface ReadFileResult {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export async function readFileContent(
  path: string,
  opts?: { startLine?: number; endLine?: number; lineNum?: boolean },
): Promise<ReadFileResult> {
  const proj = activeProject();
  if (!proj)
    return { path, content: '// No active project', totalLines: 0, startLine: 1, endLine: 0 };
  // Bytes that are not text decode to mojibake, which reads like a corrupt file
  // rather than the wrong tool. Say what the file is; the caller turns an image
  // into an image block, and there is nothing to line-number either way.
  if (isBinaryPath(path)) {
    const kind = isImagePath(path) ? 'an image' : 'a binary file';
    return {
      path,
      content: `── ${path} ──\n(${kind}, not text — reference it from code with \`import asset from './${path.split('/').pop()}'\`)`,
      totalLines: 0,
      startLine: 1,
      endLine: 0,
    };
  }
  try {
    const raw = await appStorage.read(projectPath(proj.id, path));
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const allLines = text.split('\n');
    const totalLines = allLines.length;
    const start = opts?.startLine ? Math.max(1, opts.startLine) : 1;
    const end = opts?.endLine ? Math.min(totalLines, opts.endLine) : totalLines;
    // A range past the end of the file produced a header reading `[86-26]` and no
    // body — no error, no warning, nothing to distinguish it from an empty file. One
    // range applies to every path in a multi-path read, so files of different lengths
    // make this the ordinary case, not an edge one.
    if (start > totalLines) {
      const content =
        `── ${path} (${totalLines} lines) ──\n` +
        `(requested lines ${opts?.startLine ?? 1}-${opts?.endLine ?? totalLines}, but the ` +
        `file ends at line ${totalLines} — nothing to show. Omit the range, or read a ` +
        `range within it.)`;
      return { path, content, totalLines, startLine: start, endLine: totalLines };
    }
    const sliced = allLines.slice(start - 1, end);
    const body = opts?.lineNum
      ? sliced
          .map((line, i) => `${String(start + i).padStart(String(totalLines).length)}\t│${line}`)
          .join('\n')
      : sliced.join('\n');
    const rangeTag = opts?.startLine || opts?.endLine ? ` [${start}-${end}]` : '';
    const header = `── ${path} (${totalLines} lines)${rangeTag} ──\n`;
    return { path, content: header + body, totalLines, startLine: start, endLine: end };
  } catch {
    return { path, content: `// Could not read ${path}`, totalLines: 0, startLine: 1, endLine: 0 };
  }
}
