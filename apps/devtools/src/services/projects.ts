export {};
import { batch } from '@bundled/solid-js';
import { appStorage, invoke, del } from '@bundled/yaar';
import {
  activeProject,
  setActiveProject,
  projects,
  setProjects,
  setFiles,
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
  type ProjectMeta,
} from '../core';
import { projectPath } from '../lib/paths';
import { refreshFiles, openFile } from './files';

// Project lifecycle: discovery, creation, cloning, switching, deletion, tabs.
// Depends on ./files one-way (opening a project lists its files and opens
// main.ts); ./files must never import this module back.

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

/** Clear project-scoped UI state when no project remains open. */
function clearActiveProjectState(): void {
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
      clearActiveProjectState();
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
      clearActiveProjectState();
    }
  }
}
