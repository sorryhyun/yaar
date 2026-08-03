export {};
import { batch } from '@bundled/solid-js';
import { appStorage, invoke, del, errMsg, safeParseOr } from '@bundled/yaar';
import type * as z from '@bundled/zod';
import { ProjectAppJsonSchema } from '../schema';
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
  setBundleStatus,
  setTypecheckState,
  setPreviewUrl,
  setStaticProtocol,
  setStatusText,
  openTabs,
  setOpenTabs,
  type ProjectMeta,
} from '../core';
import { projectPath } from '../lib/paths';
import { appIdFromName, scaffoldMain } from '../lib/scaffold';
import { refreshFiles, openFile } from './files';

// Project lifecycle: discovery, creation, cloning, switching, deletion, tabs.
// Depends on ./files one-way (opening a project lists its files and opens
// main.ts); ./files must never import this module back.

/** What `safeParseOr` falls back to for a missing or unreadable app.json — every field is optional. */
const EMPTY_APP_JSON: z.infer<typeof ProjectAppJsonSchema> = {};

export async function loadProjects(): Promise<void> {
  try {
    const entries = await appStorage.list('projects/');
    const dirs = entries.filter((e) => e.isDirectory);
    const metas: ProjectMeta[] = [];
    for (const dir of dirs) {
      const id = dir.path.replace(/\/$/, '').split('/').pop()!;
      // Dated from app.json, the one file every project has and the one a scaffold
      // writes last. `Date.now()` used to stand here, which stamped every project
      // with the moment the list was read — so "most recently worked on" was
      // whatever order storage happened to enumerate.
      let lastModified = 0;
      const appJson = (await appStorage.list(`projects/${id}/`)).find(
        (e) => !e.isDirectory && e.path.endsWith('app.json'),
      );
      if (appJson?.modifiedAt) {
        const ms = Date.parse(appJson.modifiedAt);
        if (!Number.isNaN(ms)) lastModified = ms;
      }
      let name = id;
      // The project's own app.json — user-written, so validated. A missing file
      // is normal (the id is a fine name); an unreadable one is logged and then
      // treated the same way, because one broken project must not hide the rest.
      const raw = await appStorage.readJsonOr<unknown>(`projects/${id}/app.json`, undefined);
      const meta = safeParseOr(ProjectAppJsonSchema, raw, EMPTY_APP_JSON, {
        label: `projects/${id}/app.json`,
      });
      if (meta.name) name = meta.name;
      metas.push({ id, name, lastModified });
    }
    setProjects(metas);
  } catch (err) {
    // A failed listing is not "you have no projects" — without this line the
    // sidebar renders its empty state and the user reaches for New Project.
    console.error('[devtools] loading projects failed', err);
    setStatusText(`Could not load projects: ${errMsg(err)}`);
    setProjects([]);
  }
}

export async function createProject(name: string): Promise<string> {
  const id = Date.now().toString();
  const appId = appIdFromName(name, id);
  await appStorage.save(projectPath(id, 'src/main.ts'), scaffoldMain(name, appId));
  await appStorage.save(projectPath(id, 'src/styles.css'), `#app { height: 100%; }\n`);
  // `appId` is the field the compiler compares `defineApp({ id })` against — not
  // `id`, which nothing reads. Writing it here is what makes the scaffold compile:
  // an id that disagrees with app.json fails protocol extraction, and an id that is
  // absent fails it too.
  await appStorage.save(
    projectPath(id, 'app.json'),
    JSON.stringify({ appId, name, icon: '🧩', version: '1.0.0' }, null, 2),
  );
  await loadProjects();
  await openProject(id);
  setStatusText(`Created project "${name}"`);
  return id;
}

export interface CloneAppResult {
  id: string;
  /** Root AGENTS.md content, or null when the cloned app does not provide one. */
  agentsMd: string | null;
}

export async function cloneApp(appId: string): Promise<CloneAppResult> {
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
  // The clone payload already told us whether the root instruction file exists.
  // Read it back from the newly written project rather than forwarding the source
  // payload, so the command returns precisely the instructions its caller can now
  // act on. `null` is intentional: an absent AGENTS.md is different from a present
  // but empty one (which returns '').
  const hasAgentsMd = result?.files?.some((file) => file.path === 'AGENTS.md') ?? false;
  let agentsMd: string | null = null;
  if (hasAgentsMd) {
    const raw = await appStorage.read(projectPath(id, 'AGENTS.md'));
    if (typeof raw !== 'string') throw new Error('Cloned AGENTS.md is not text');
    agentsMd = raw;
  }
  await loadProjects();
  await openProject(id);
  setStatusText(`Cloned "${name}"`);
  return { id, agentsMd };
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
  // Same reasoning for the type-check verdict: it was reached about the project
  // being switched away from. `diagnostics` is left standing until the next
  // typecheck writes it, but `compileStatus` no longer reads it as current.
  setTypecheckState('unknown');
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
    setBundleStatus('idle');
    setTypecheckState('unknown');
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
