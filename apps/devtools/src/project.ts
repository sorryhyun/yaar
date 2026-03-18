export {};
import { createSignal, batch } from '@bundled/solid-js';
import { appStorage, dev, invokeJson } from '@bundled/yaar';

// ── Types ──

export interface ProjectMeta {
  id: string;
  name: string;
  lastModified: number;
}

export interface FileEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
}

export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ConsoleEntry {
  level: string;
  args: string[];
  timestamp: number;
}

// ── Signals ──

export const [activeProject, setActiveProject] = createSignal<ProjectMeta | null>(null);
export const [projects, setProjects] = createSignal<ProjectMeta[]>([]);
export const [files, setFiles] = createSignal<FileEntry[]>([]);
export const [openFilePath, setOpenFilePath] = createSignal<string | null>(null);
export const [openFileContent, setOpenFileContent] = createSignal<string | null>(null);
export const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([]);
export const [compileStatus, setCompileStatus] = createSignal<
  'idle' | 'compiling' | 'success' | 'error'
>('idle');
export const [compileErrors, setCompileErrors] = createSignal<string[]>([]);
export const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
export const [statusText, setStatusText] = createSignal('Ready');

// ── Feature: Multi-Project Tabs ──
export const [openTabs, setOpenTabs] = createSignal<string[]>([]);

// ── Feature: Bundled Libraries ──
export const [bundledLibs, setBundledLibs] = createSignal<string[]>([]);

// ── Feature: Console Capture ──
export const [consoleLogs, setConsoleLogs] = createSignal<ConsoleEntry[]>([]);
export const [previewIframeUrl, setPreviewIframeUrl] = createSignal<string | null>(null);

// ── Feature: Preview Window ──
export const [previewWindowId, setPreviewWindowId] = createSignal<string | null>(null);

// ── Helpers ──

function projectPath(projectId: string, sub?: string): string {
  return sub ? `projects/${projectId}/${sub}` : `projects/${projectId}`;
}

// Recursively list all files and directories under a storage path.
// appStorage.list() is shallow — only returns direct children.
// This function walks subdirectories and returns a flat list of all entries
// with paths relative to the given prefix.
async function listAllFiles(storagePath: string, prefix: string): Promise<FileEntry[]> {
  let entries: FileEntry[];
  try {
    entries = (await appStorage.list(storagePath)) as FileEntry[];
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

    result.push({ path: cleanPath, isDirectory: entry.isDirectory, size: entry.size });

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
    const dirs = (entries as FileEntry[]).filter((e) => e.isDirectory);
    const metas: ProjectMeta[] = [];
    for (const dir of dirs) {
      const id = dir.path.replace(/\/$/, '').split('/').pop()!;
      let name = id;
      try {
        const meta = await appStorage.readJson<{ name: string }>(`projects/${id}/app.json`);
        if (meta?.name) name = meta.name;
      } catch {
        /* no metadata */
      }
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
    `export {};\nimport { createSignal } from '@bundled/solid-js';\nimport html from '@bundled/solid-js/html';\nimport { render } from '@bundled/solid-js/web';\nimport './styles.css';\n\nconst App = () => html\`\n  <div class="y-app y-p-3">\n    <h1>Hello, ${name}!</h1>\n  </div>\`\n;\n\nrender(App, document.getElementById('app')!);\n`
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
  const result = await invokeJson<{
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

export async function editFile(path: string, oldString: string, newString: string): Promise<boolean> {
  const proj = activeProject();
  if (!proj) return false;
  const content = await appStorage.read(projectPath(proj.id, path));
  if (typeof content !== 'string') return false;
  if (!content.includes(oldString)) return false;
  const updated = content.replace(oldString, newString);
  await writeFile(path, updated);
  return true;
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

// ── Dev Operations (call server actions via verb API) ──

export async function compile(): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  setCompileStatus('compiling');
  setCompileErrors([]);
  setStatusText('Compiling...');
  try {
    const result = await dev.compile(projectPath(proj.id), { title: proj.name });
    if (result.success) {
      batch(() => {
        setCompileStatus('success');
        setCompileErrors([]);
        setPreviewUrl(result.previewUrl ?? null);
        setPreviewIframeUrl(result.previewUrl ?? null);
        setConsoleLogs([]);
        setStatusText('Compilation successful');
      });
    } else {
      const errors = result.errors ?? [(result as { error?: string }).error ?? 'Compilation failed'];
      batch(() => {
        setCompileStatus('error');
        setCompileErrors(errors);
        setStatusText(errors.join('\n'));
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    batch(() => {
      setCompileStatus('error');
      setCompileErrors([msg]);
      setStatusText(`Compile error: ${msg}`);
    });
  }
}

export async function typecheck(): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  setStatusText('Type checking...');
  try {
    const result = await dev.typecheck(projectPath(proj.id));
    if (result.success) {
      setDiagnostics([]);
      setStatusText('No type errors');
    } else {
      const raw = result.diagnostics ?? [(result as { error?: string }).error ?? 'Unknown error'];
      const parsed = parseDiagnostics(raw.join('\n'));
      setDiagnostics(parsed.length > 0 ? parsed : raw.map((m) => ({ file: '?', line: 0, message: m, severity: 'error' as const })));
      setStatusText(`${parsed.length || raw.length} type error(s)`);
    }
  } catch (err) {
    setStatusText(`Typecheck error: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}

export async function deploy(opts: {
  appId: string;
  name?: string;
  icon?: string;
  description?: string;
  permissions?: string[];
}): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  setStatusText('Deploying...');
  try {
    // If permissions not explicitly passed, fall back to project's app.json
    let finalOpts = { ...opts };
    if (finalOpts.permissions === undefined) {
      try {
        const appJson = await appStorage.readJson<{ permissions?: string[] }>(
          projectPath(proj.id, 'app.json'),
        );
        if (Array.isArray(appJson?.permissions)) {
          finalOpts.permissions = appJson.permissions;
        }
      } catch {
        /* no app.json or no permissions field */
      }
    }
    const result = await dev.deploy(projectPath(proj.id), finalOpts);
    if (result.success) {
      setStatusText(`Deployed as "${result.name ?? opts.appId}"`);
    } else {
      setStatusText(`Deploy failed: ${result.error ?? 'Unknown'}`);
    }
  } catch (err) {
    setStatusText(`Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}

// ── Bundled Libraries ──

export async function loadBundledLibraries(): Promise<void> {
  try {
    const libs = await dev.bundledLibraries();
    setBundledLibs(libs);
  } catch {
    /* non-fatal */
  }
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

// ── Diagnostic parsing ──

function parseDiagnostics(raw: string): Diagnostic[] {
  const lines = raw.split('\n');
  const result: Diagnostic[] = [];
  for (const line of lines) {
    // Match: src/main.ts(12,5): error TS2304: Cannot find name 'x'.
    const m = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+\w+:\s*(.+)/);
    if (m) {
      result.push({
        file: m[1],
        line: parseInt(m[2], 10),
        message: m[4],
        severity: m[3] as 'error' | 'warning',
      });
    }
  }
  return result;
}
