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
  setDiagnostics,
  setCompileStatus,
  setPreviewUrl,
  setStatusText,
  openTabs,
  setOpenTabs,
  setConsoleLogs,
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
    files: { path: string; content: string }[];
    meta: Record<string, unknown>;
  }>('yaar://apps/' + appId, { action: 'clone' });
  const meta = result?.meta ?? {};
  const name = typeof meta.name === 'string' ? meta.name : appId;
  const id = Date.now().toString();
  // Preserve all meta fields (including permissions) from the original app
  await appStorage.save(projectPath(id, 'app.json'), JSON.stringify({ ...meta, name }, null, 2));
  if (result?.files) {
    for (const file of result.files) {
      await appStorage.save(projectPath(id, file.path), file.content);
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
        setDiagnostics([]);
        setCompileStatus('idle');
        setPreviewUrl(null);
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
        setDiagnostics([]);
        setCompileStatus('idle');
        setPreviewUrl(null);
      });
    }
  }
}

export async function refreshFiles(projectId?: string): Promise<void> {
  const id = projectId ?? activeProject()?.id;
  if (!id) return;
  const basePath = projectPath(id);
  try {
    const mapped = await listAllFiles(basePath, basePath);
    setFiles(mapped);
  } catch {
    setFiles([]);
  }
}

// ── File Operations ──

export async function openFile(path: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  try {
    const content = await appStorage.read(projectPath(proj.id, path));
    batch(() => {
      setOpenFilePath(path);
      setOpenFileContent(typeof content === 'string' ? content : JSON.stringify(content));
    });
  } catch {
    batch(() => {
      setOpenFilePath(path);
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
  oldString: string,
  newString: string,
): Promise<boolean> {
  const proj = activeProject();
  if (!proj) return false;
  const content = await appStorage.read(projectPath(proj.id, path));
  if (typeof content !== 'string') return false;
  if (!content.includes(oldString)) return false;
  // A function replacer inserts newString literally. Passing it as a string would
  // expand $&, $1, $` and $' — so replacing with source containing a `$` would
  // silently corrupt the file.
  const updated = content.replace(oldString, () => newString);
  await writeFile(path, updated);
  return true;
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
    if (Array.isArray(entries)) setConsoleLogs(entries.slice(-200));
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
  opts?: { startLine?: number; endLine?: number },
): Promise<ReadFileResult> {
  const proj = activeProject();
  if (!proj)
    return { path, content: '// No active project', totalLines: 0, startLine: 1, endLine: 0 };
  try {
    const raw = await appStorage.read(projectPath(proj.id, path));
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const allLines = text.split('\n');
    const totalLines = allLines.length;
    const start = opts?.startLine ? Math.max(1, opts.startLine) : 1;
    const end = opts?.endLine ? Math.min(totalLines, opts.endLine) : totalLines;
    const sliced = allLines.slice(start - 1, end);
    const width = String(totalLines).length;
    const numbered = sliced
      .map((line, i) => `${String(start + i).padStart(width)}\t│${line}`)
      .join('\n');
    const rangeTag = opts?.startLine || opts?.endLine ? ` [${start}-${end}]` : '';
    const header = `── ${path} (${totalLines} lines)${rangeTag} ──\n`;
    return { path, content: header + numbered, totalLines, startLine: start, endLine: end };
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
