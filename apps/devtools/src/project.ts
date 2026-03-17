export {};
import { createSignal, batch } from '@bundled/solid-js';
import { appStorage, dev } from '@bundled/yaar';

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
export const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
export const [statusText, setStatusText] = createSignal('Ready');

// ── Helpers ──

function projectPath(projectId: string, sub?: string): string {
  return sub ? `projects/${projectId}/${sub}` : `projects/${projectId}`;
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
    `export {};\nimport { createSignal } from '@bundled/solid-js';\nimport html from '@bundled/solid-js/html';\nimport { render } from '@bundled/solid-js/web';\nimport './styles.css';\n\nconst App = () => html\`\n  <div class="y-app y-p-3">\n    <h1>Hello, ${name}!</h1>\n  </div>\n\`;\n\nrender(App, document.getElementById('app')!);\n`
  );
  await appStorage.save(projectPath(id, 'src/styles.css'), `#app { height: 100%; }\n`);
  await appStorage.save(projectPath(id, 'app.json'), JSON.stringify({ name }, null, 2));
  await loadProjects();
  await openProject(id);
  setStatusText(`Created project "${name}"`);
  return id;
}

export async function openProject(id: string): Promise<void> {
  const proj = projects().find((p) => p.id === id);
  if (!proj) return;
  setActiveProject(proj);
  await refreshFiles(id);
  // Open main.ts by default
  await openFile('src/main.ts');
  setStatusText(`Opened "${proj.name}"`);
}

export async function deleteProject(id: string): Promise<void> {
  try {
    // Remove all files recursively
    const allFiles = await appStorage.list(projectPath(id));
    for (const f of (allFiles as FileEntry[]).filter((e) => !e.isDirectory).reverse()) {
      const relPath = f.path.startsWith(`projects/${id}/`)
        ? f.path.slice(`projects/${id}/`.length)
        : f.path;
      await appStorage.remove(projectPath(id, relPath));
    }
  } catch {
    /* best effort */
  }
  if (activeProject()?.id === id) {
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
  await loadProjects();
  setStatusText('Project deleted');
}

export async function refreshFiles(projectId?: string): Promise<void> {
  const id = projectId ?? activeProject()?.id;
  if (!id) return;
  try {
    const entries = await appStorage.list(projectPath(id));
    const mapped = (entries as FileEntry[]).map((e) => ({
      ...e,
      // Strip the projects/{id}/ prefix for display
      path: e.path.startsWith(`projects/${id}/`)
        ? e.path.slice(`projects/${id}/`.length)
        : e.path,
    }));
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

export async function editFile(path: string, oldString: string, newString: string): Promise<void> {
  const proj = activeProject();
  if (!proj) return;
  const content = await appStorage.read(projectPath(proj.id, path));
  if (typeof content !== 'string') return;
  const updated = content.replace(oldString, newString);
  await writeFile(path, updated);
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
  setStatusText('Compiling...');
  try {
    const result = await dev.compile(projectPath(proj.id), { title: proj.name });
    if (result.success) {
      batch(() => {
        setCompileStatus('success');
        setPreviewUrl(result.previewUrl ?? null);
        setStatusText('Compilation successful');
      });
    } else {
      setCompileStatus('error');
      setStatusText(result.errors?.join('\n') ?? 'Compilation failed');
    }
  } catch (err) {
    setCompileStatus('error');
    setStatusText(`Compile error: ${err instanceof Error ? err.message : 'Unknown'}`);
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
      const parsed = parseDiagnostics(result.diagnostics.join('\n'));
      setDiagnostics(parsed);
      setStatusText(`${parsed.length} type error(s)`);
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
    const result = await dev.deploy(projectPath(proj.id), opts);
    if (result.success) {
      setStatusText(`Deployed as "${result.name ?? opts.appId}"`);
    } else {
      setStatusText(`Deploy failed: ${result.error ?? 'Unknown'}`);
    }
  } catch (err) {
    setStatusText(`Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
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
