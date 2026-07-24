export {};
import { batch } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';
import {
  activeProject,
  setFiles,
  openFilePath,
  setOpenFilePath,
  setOpenFileContent,
  setOpenFileImage,
  setStatusText,
} from '../core';
import { projectPath, isImagePath, isBinaryPath } from '../lib/paths';
import { applyEdits, formatRemoved, type EditSpec } from '../lib/edits';
import { listAllFiles } from './fs-walk';

// File I/O against the active project's sandbox: listing, reading, writing,
// editing, copying, deleting. The edit *algebra* lives in ../lib/edits — this
// module only supplies storage and the signals.

export async function refreshFiles(projectId?: string): Promise<void> {
  const id = projectId ?? activeProject()?.id;
  if (!id) return;
  const basePath = projectPath(id);
  try {
    const mapped = await listAllFiles(basePath, basePath);
    // Attach line/byte counts so the `project` state can answer "how big is this
    // file" without a read per file (agents used to read line 1 just to see the
    // "(N lines)" header). Projects are a handful of source files, so reading
    // them in parallel here is cheap; a file that cannot be read stays uncounted.
    await Promise.all(
      mapped.map(async (entry) => {
        if (entry.isDirectory || isBinaryPath(entry.path)) return;
        try {
          const raw = await appStorage.read(projectPath(id, entry.path));
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          entry.lines = text.split('\n').length;
          entry.bytes = new TextEncoder().encode(text).length;
        } catch {
          /* unreadable — leave counts unset */
        }
      }),
    );
    setFiles(mapped);
  } catch {
    setFiles([]);
  }
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

export async function writeFile(path: string, content: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  await appStorage.save(projectPath(proj.id, path), content);
  if (openFilePath() === path) setOpenFileContent(content);
  await refreshFiles();
  setStatusText(`Saved ${path}`);
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
  await writeFile(path, updated);
  return {
    editsApplied: edits.length,
    lines: updated.split('\n').length,
    removed: formatRemoved(removals),
  };
}

export async function copyFile(from: string, to: string): Promise<void> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project');
  const raw = await appStorage.read(projectPath(proj.id, from));
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  await appStorage.save(projectPath(proj.id, to), content);
  await refreshFiles();
  setStatusText(`Copied ${from} → ${to}`);
}

export async function deleteFile(path: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  await appStorage.remove(projectPath(proj.id, path));
  if (openFilePath() === path) {
    batch(() => {
      setOpenFilePath(null);
      setOpenFileContent(null);
      setOpenFileImage(null);
    });
  }
  await refreshFiles();
  setStatusText(`Deleted ${path}`);
}

// ── Read (non-mutating) ──

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
