export {};
import { batch } from '@bundled/solid-js';
import { appStorage, invoke, del } from '@bundled/yaar';
import {
  activeProject,
  setActiveProject,
  projects,
  setProjects,
  setFiles,
  openFilePath,
  setOpenFilePath,
  setOpenFileContent,
  setOpenFileImage,
  setDiagnostics,
  setCompileStatus,
  setPreviewUrl,
  setStaticProtocol,
  setStatusText,
  openTabs,
  setOpenTabs,
  setConsoleLogs,
  consoleLogs,
  previewWindowId,
  projectPath,
  type ProjectMeta,
  type FileEntry,
  type ConsoleEntry,
} from './store';

// This module owns project lifecycle, file I/O and the console poll. Shared state
// lives in ./store and the dev-server operations (compile/typecheck/deploy/git)
// live in ./build — both are re-exported below so that `from './project'` remains
// the single import site for the rest of the app. Nothing outside needs to know
// the split happened.
export * from './store';
export * from './build';

// Recursively list all files and directories under a storage path.
// appStorage.list() is shallow — only returns direct children.
// This function walks subdirectories and returns a flat list of all entries
// with paths relative to the given prefix.
async function listAllFiles(storagePath: string, prefix: string): Promise<FileEntry[]> {
  let entries: FileEntry[];
  try {
    entries = await appStorage.list(storagePath);
  } catch {
    return [];
  }

  const result: FileEntry[] = [];
  for (const entry of entries) {
    // Strip the storage prefix to get a display-relative path
    const relativePath = entry.path.startsWith(prefix + '/')
      ? entry.path.slice(prefix.length + 1)
      : entry.path.startsWith(prefix)
        ? entry.path.slice(prefix.length)
        : entry.path;

    // Normalize: remove trailing slash from directory paths
    const cleanPath = relativePath.replace(/\/$/, '');

    result.push({ path: cleanPath, isDirectory: entry.isDirectory });

    // Recurse into subdirectories
    if (entry.isDirectory) {
      const subPath = entry.path.replace(/\/$/, '');
      const children = await listAllFiles(subPath, prefix);
      result.push(...children);
    }
  }
  return result;
}

// ── Project Management ──

export async function loadProjects(): Promise<void> {
  try {
    const entries = await appStorage.list('projects/');
    const dirs = entries.filter((e) => e.isDirectory);
    const metas: ProjectMeta[] = [];
    for (const dir of dirs) {
      const id = dir.path.replace(/\/$/, '').split('/').pop()!;
      let name = id;
      const meta = await appStorage.readJsonOr<{ name: string } | null>(
        `projects/${id}/app.json`,
        null,
      );
      if (meta?.name) name = meta.name;
      metas.push({ id, name, lastModified: Date.now() });
    }
    setProjects(metas);
  } catch {
    setProjects([]);
  }
}

export async function createProject(name: string): Promise<string> {
  const id = Date.now().toString();
  await appStorage.save(
    projectPath(id, 'src/main.ts'),
    `import { createSignal } from '@bundled/solid-js';\nimport html from '@bundled/solid-js/html';\nimport { render } from '@bundled/solid-js/web';\nimport './styles.css';\n\nconst App = () => {\n  const [count, setCount] = createSignal(0);\n  return html\`\n    <div class="y-app y-p-3">\n      <h1>Hello, ${name}!</h1>\n      <button class="y-btn y-btn-primary" onClick=\${() => setCount(count() + 1)}>\n        Clicked \${count} times\n      </button>\n    </div>\`;\n};\n\nrender(App, document.getElementById('app')!);\n`,
  );
  await appStorage.save(projectPath(id, 'src/styles.css'), `#app { height: 100%; }\n`);
  await appStorage.save(projectPath(id, 'app.json'), JSON.stringify({ name }, null, 2));
  await loadProjects();
  await openProject(id);
  setStatusText(`Created project "${name}"`);
  return id;
}

export async function cloneApp(appId: string): Promise<string> {
  setStatusText(`Cloning "${appId}"...`);
  const result = await invoke<{
    // `encoding` is set for files whose bytes are not valid UTF-8 (images, fonts,
    // wasm). Writing those with the default utf-8 encoding re-encodes the base64
    // payload as text and corrupts the asset — see cloneAppSource.
    files: { path: string; content: string; encoding?: 'base64' }[];
    meta: Record<string, unknown>;
  }>('yaar://apps/' + appId, { action: 'clone' });
  const meta = result?.meta ?? {};
  const name = typeof meta.name === 'string' ? meta.name : appId;
  const id = Date.now().toString();
  // Preserve all meta fields (including permissions) from the original app
  await appStorage.save(projectPath(id, 'app.json'), JSON.stringify({ ...meta, name }, null, 2));
  if (result?.files) {
    for (const file of result.files) {
      await appStorage.save(
        projectPath(id, file.path),
        file.content,
        file.encoding ? { encoding: file.encoding } : undefined,
      );
    }
  }
  await loadProjects();
  await openProject(id);
  setStatusText(`Cloned "${name}"`);
  return id;
}

export async function openProject(id: string): Promise<void> {
  const proj = projects().find((p) => p.id === id);
  if (!proj) return;
  // Add to tabs if not present
  if (!openTabs().includes(id)) setOpenTabs([...openTabs(), id]);
  setActiveProject(proj);
  // The static manifest belongs to whichever project was last compiled — drop it
  // on switch so the manifest command never reports another project's protocol.
  setStaticProtocol(null);
  await refreshFiles(id);
  // Open main.ts by default
  await openFile('src/main.ts');
  setStatusText(`Opened "${proj.name}"`);
}

export async function deleteProject(id: string): Promise<void> {
  try {
    // Remove the entire project directory (server handles recursive deletion)
    await appStorage.remove(projectPath(id));
  } catch {
    /* best effort */
  }
  try {
    // And the throwaway namespace its previews wrote to (see the preview command).
    // Nothing else will ever reclaim it — a `preview--*` app is not installed, so it
    // never appears anywhere an orphan could be noticed.
    await del(`yaar://apps/preview--${id}/storage/`);
  } catch {
    /* best effort — the project may never have been previewed */
  }
  // Remove from tabs
  setOpenTabs(openTabs().filter((t) => t !== id));
  if (activeProject()?.id === id) {
    const remaining = openTabs();
    if (remaining.length > 0) {
      await openProject(remaining[remaining.length - 1]);
    } else {
      batch(() => {
        setActiveProject(null);
        setFiles([]);
        setOpenFilePath(null);
        setOpenFileContent(null);
        setOpenFileImage(null);
        setDiagnostics([]);
        setCompileStatus('idle');
        setPreviewUrl(null);
        setStaticProtocol(null);
      });
    }
  }
  await loadProjects();
  setStatusText('Project deleted');
}

export function closeTab(id: string): void {
  const tabs = openTabs().filter((t) => t !== id);
  setOpenTabs(tabs);
  if (activeProject()?.id === id) {
    if (tabs.length > 0) {
      openProject(tabs[tabs.length - 1]);
    } else {
      batch(() => {
        setActiveProject(null);
        setFiles([]);
        setOpenFilePath(null);
        setOpenFileContent(null);
        setOpenFileImage(null);
        setDiagnostics([]);
        setCompileStatus('idle');
        setPreviewUrl(null);
        setStaticProtocol(null);
      });
    }
  }
}

// Extensions whose bytes are not meaningfully countable as text — skip metadata
// rather than report the size of a base64/garbled decode.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|mp3|wav)$/i;

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
        if (entry.isDirectory || BINARY_EXT.test(entry.path)) return;
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

// ── File Operations ──

// Raster images the editor renders as a picture. SVG is deliberately absent: it is
// text the user may want to edit, and it highlights fine as markup.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

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

/** Whether this path is a raster image — rendered, never decoded as text. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/**
 * Whether this path holds bytes that are not text at all. Reading one as text gives
 * mojibake, so the callers that would have shown it say what the file is instead.
 */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXT.test(path);
}

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

/**
 * One edit step. Either `search`/`replace` (first match), or a 1-based inclusive
 * `startLine`/`endLine` range where `replace` omitted (or '') deletes the lines.
 * Line-range edits require `anchor`: the current text of `startLine`, compared
 * trimmed. Search mode anchors on content already; line numbers anchor on nothing,
 * so a stale one would splice into the wrong place silently.
 */
export interface EditSpec {
  search?: string;
  replace?: string;
  startLine?: number;
  endLine?: number;
  anchor?: string;
}

/** What one edit step produced: the new content, and the text it took out. */
interface EditResult {
  content: string;
  removed: string;
}

/**
 * Keep the head and tail of removed text, eliding the middle — a wrong splice is
 * usually visible at either edge, and both edges together beat twice as much head.
 */
export function truncateRemoved(text: string, max = 500): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${elided} chars elided] …\n${text.slice(-tail)}`;
}

function applyEdit(content: string, edit: EditSpec, label: string): EditResult {
  const hasSearch = edit.search !== undefined;
  const hasRange = edit.startLine !== undefined || edit.endLine !== undefined;
  if (hasSearch && hasRange) {
    throw new Error(`${label}: pass search/replace OR startLine/endLine, not both`);
  }
  if (hasSearch) {
    if (edit.replace === undefined) {
      throw new Error(
        `${label}: missing replacement text (pass replace or newString; '' deletes the match)`,
      );
    }
    if (!content.includes(edit.search!)) {
      throw new Error(`${label}: search string not found in file`);
    }
    // A function replacer inserts the replacement literally. Passing it as a string
    // would expand $&, $1, $` and $' — so a replacement containing `$` would
    // silently corrupt the file.
    return {
      content: content.replace(edit.search!, () => edit.replace!),
      removed: edit.search!,
    };
  }
  if (hasRange) {
    const lines = content.split('\n');
    const start = Math.trunc(Number(edit.startLine ?? edit.endLine));
    const end = Math.trunc(Number(edit.endLine ?? edit.startLine));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      throw new Error(
        `${label}: invalid line range ${edit.startLine}-${edit.endLine} ` +
          '(1-based, inclusive, startLine <= endLine)',
      );
    }
    if (start > lines.length) {
      throw new Error(
        `${label}: startLine ${start} is past the end of the file (${lines.length} lines)`,
      );
    }
    const actual = lines[start - 1] ?? '';
    if (edit.anchor === undefined) {
      throw new Error(
        `${label}: line-range edits require anchor (the current text of startLine). ` +
          `Line ${start} is: ${JSON.stringify(actual)}`,
      );
    }
    if (edit.anchor.trim() !== actual.trim()) {
      throw new Error(
        `${label}: anchor mismatch at line ${start} — expected ${JSON.stringify(edit.anchor)}, ` +
          `found ${JSON.stringify(actual)}. Nothing was written; re-read the file for current line numbers.`,
      );
    }
    // `replace` omitted or '' deletes the range; otherwise its lines take its place.
    const replacement = edit.replace ? edit.replace.split('\n') : [];
    const count = Math.min(end, lines.length) - start + 1;
    const removed = lines.splice(start - 1, count, ...replacement);
    return { content: lines.join('\n'), removed: removed.join('\n') };
  }
  throw new Error(
    `${label}: provide search/replace (aliases oldString/newString) or startLine/endLine + anchor`,
  );
}

/**
 * Apply edits sequentially against in-memory content. Throws on the first edit
 * that fails, naming its index — the caller writes nothing in that case, so a
 * multi-edit is all-or-nothing (an anchor mismatch anywhere aborts the batch).
 * Line numbers in later edits refer to the content AFTER earlier edits have been
 * applied. Returns the new content plus each edit's removed text, in order.
 */
export function applyEdits(
  content: string,
  edits: EditSpec[],
): { content: string; removals: string[] } {
  let current = content;
  const removals: string[] = [];
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `edit ${i + 1} of ${edits.length}` : 'edit';
    const result = applyEdit(current, edit, label);
    current = result.content;
    removals.push(result.removed);
  });
  return { content: current, removals };
}

/** One echo of what an edit took out, budget shared so a big batch stays bounded. */
function formatRemoved(removals: string[]): string {
  if (removals.length === 1) return truncateRemoved(removals[0] ?? '');
  const budget = Math.max(120, Math.floor(500 / removals.length));
  return removals
    .map((text, i) => `── edit ${i + 1} ──\n${truncateRemoved(text, budget)}`)
    .join('\n');
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

// ── Console ──

export function clearConsoleLogs(): void {
  setConsoleLogs([]);
}

export function addConsoleEntry(entry: ConsoleEntry): void {
  setConsoleLogs((prev) => {
    const next = [...prev, entry];
    return next.length > 200 ? next.slice(-200) : next;
  });
}

/**
 * Pull the preview app's console buffer once and update the display signal.
 * The preview runs as its own registered window, so we read its captured
 * console over the app protocol (built-in `__console` state key).
 */
export async function refreshConsole(): Promise<void> {
  const wid = previewWindowId();
  if (!wid) return;
  try {
    const entries = await invoke<ConsoleEntry[]>(`yaar://windows/${wid}`, {
      action: 'app_query',
      stateKey: '__console',
    });
    if (Array.isArray(entries)) {
      // The preview buffer is a snapshot, while evaluations are initiated by Dev Tools
      // itself. Retain those local audit entries when the next preview poll arrives.
      const evaluations = consoleLogs().filter((entry) => entry.source === 'evaluation');
      const merged = [...entries, ...evaluations]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-200);
      setConsoleLogs(merged);
    }
  } catch {
    /* preview window may be closed — leave the last snapshot in place */
  }
}

let consolePollTimer: ReturnType<typeof setInterval> | null = null;

/** Start polling the preview console so the panel stays live while a preview is open. */
export function startConsolePolling(intervalMs = 1500): void {
  if (consolePollTimer) return;
  consolePollTimer = setInterval(() => {
    void refreshConsole();
  }, intervalMs);
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

// ── Grep ──

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export async function grep(
  pattern: string,
  glob?: string,
): Promise<{ matches: GrepMatch[]; truncated?: boolean }> {
  const proj = activeProject();
  if (!proj) return { matches: [] };
  const storagePath = `projects/${proj.id}`;
  const result = await invoke<{ matches: GrepMatch[]; truncated?: boolean }>(
    `yaar://apps/self/storage/${storagePath}`,
    { action: 'grep', pattern, ...(glob ? { glob } : {}) },
  );
  return { matches: result?.matches ?? [], truncated: result?.truncated };
}
