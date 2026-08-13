export {};
import { batch } from '@bundled/solid-js';
import { appStorage, invoke, list, del, errMsg, safeParseOr } from '@bundled/yaar';
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

/**
 * Where each project came from, keyed by project id.
 *
 * A sidecar at the appStorage root rather than a field in the project's own
 * `app.json`, because that file is the app's manifest: `deploy` ships it, so a
 * bookkeeping key written there would leak into every installed app. It is also not a
 * dotfile inside the project, which would show up in the file listing the agent reads.
 * Nothing outside this module writes it.
 */
const ORIGINS_PATH = 'project-origins.json';

async function readOrigins(): Promise<Record<string, string>> {
  const raw = await appStorage.readJsonOr<unknown>(ORIGINS_PATH, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, origin] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof origin === 'string') out[id] = origin;
  }
  return out;
}

/**
 * Record where a project came from. Best effort on purpose: failing to write the
 * marker must not fail the create or clone that produced the project — an unmarked
 * project is merely one cleanup will leave alone, which is the safe direction.
 */
async function recordOrigin(id: string, origin: string): Promise<void> {
  try {
    const origins = await readOrigins();
    origins[id] = origin;
    await appStorage.save(ORIGINS_PATH, JSON.stringify(origins, null, 2));
  } catch (err) {
    console.error('[devtools] recording project origin failed', err);
  }
}

/**
 * Delete the throwaway storage tree of every preview whose project is gone.
 *
 * A preview runs under `preview--{projectId}` and writes to `apps/preview--{projectId}/`,
 * a namespace nothing else in YAAR knows about: a `preview--*` app is not installed, so it
 * appears in no app list and no uninstall reclaims it. `deleteProject` drops its own, best
 * effort — and best effort is exactly how six of these accumulated across ten days on one
 * machine, one carrying a whole cloned source tree and another ~600KB of PDF and draft
 * data, none of them mappable back to the project that wrote them once the id is gone.
 *
 * ── Why `openPreview` calls this and not `loadProjects` ──
 *
 * Opening a project is a read; previewing is what *creates* these trees, so it is what
 * should retire them. Hanging the sweep off the project listing meant deleting storage on
 * a path that only meant to populate a sidebar — and running it on every create, delete
 * and tab switch, none of which can have produced a new orphan.
 *
 * The orphan test is exact rather than time-based: a directory whose `{projectId}` names
 * no project. A live project's preview tree is left alone even between previews, since it
 * is that project's storage and the next preview should find it.
 *
 * The live set is read from storage here rather than taken from the `projects` signal:
 * with an empty or half-loaded list every tree looks like an orphan, and this function
 * deletes. A failed listing therefore throws before any delete is attempted, which is the
 * safe direction — nothing is reclaimed this time round.
 *
 * Deliberately silent about what it removed; a toast would report platform bookkeeping to
 * someone who asked for a preview.
 */
export async function reclaimOrphanedPreviewStorage(): Promise<void> {
  try {
    const projectDirs = await appStorage.list('projects/');
    const live = new Set(
      projectDirs
        .filter((e) => e.isDirectory)
        .map((e) => e.path.replace(/\/$/, '').split('/').pop())
        .filter((id): id is string => !!id),
    );

    // `yaar://storage/*` answers with resource links (`uri`/`name`), not the internal
    // `path` shape `appStorage.list` maps back for its callers. Reading `path` here threw
    // on the first entry and the catch below swallowed it, so nothing was ever reclaimed.
    const entries = await list<{ uri?: string; name?: string }[]>('yaar://storage/apps');
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const appId = String(entry.name ?? entry.uri ?? '')
        .replace(/\/$/, '')
        .split('/')
        .pop();
      if (!appId || !appId.startsWith('preview--')) continue;
      if (live.has(appId.slice('preview--'.length))) continue;
      try {
        await del(`yaar://apps/${appId}/storage/`);
      } catch (err) {
        // One undeletable tree must not stop the sweep reaching the rest.
        console.error(`[devtools] reclaiming ${appId} failed`, err);
      }
    }
  } catch (err) {
    console.error('[devtools] preview storage cleanup failed', err);
  }
}

export async function loadProjects(): Promise<void> {
  try {
    const entries = await appStorage.list('projects/');
    const dirs = entries.filter((e) => e.isDirectory);
    const origins = await readOrigins();
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
      metas.push({ id, name, lastModified, origin: origins[id] });
    }
    setProjects(metas);
    // Prune markers for projects that no longer exist. `deleteProject` drops its own,
    // but a project removed any other way (storage edited directly, an older build)
    // would otherwise leave a marker that a recycled id could inherit.
    const live = new Set(metas.map((m) => m.id));
    const stale = Object.keys(origins).filter((id) => !live.has(id));
    if (stale.length > 0) {
      for (const id of stale) delete origins[id];
      try {
        await appStorage.save(ORIGINS_PATH, JSON.stringify(origins, null, 2));
      } catch {
        /* best effort — the markers are a convenience, not the source of truth */
      }
    }
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
  await recordOrigin(id, 'new');
  await loadProjects();
  await openProject(id);
  setStatusText(`Created project "${name}"`);
  return id;
}

export interface InstalledApp {
  id: string;
  name: string;
  description?: string;
  /** 'app' or 'system' — shown so a clone target that is part of the OS is obvious. */
  kind?: string;
  version?: string;
}

/**
 * The installed apps, as clone targets for the toolbar's Clone button.
 *
 * `yaar://apps/` answers with `uri` and metadata, never source; the id is the last
 * segment, and it is what `cloneApp` takes. Sorted by name because this list is
 * read by a human picking one, not by a caller matching an id.
 */
export async function listInstalledApps(): Promise<InstalledApp[]> {
  const items = await list<
    { uri?: string; name?: string; description?: string; kind?: string; version?: string }[]
  >('yaar://apps/');
  const rows = Array.isArray(items) ? items : [];
  return rows
    .map((item) => {
      const id = String(item.uri ?? '')
        .replace(/\/$/, '')
        .split('/')
        .pop();
      return {
        id: id ?? '',
        name: item.name ?? id ?? '',
        description: item.description,
        kind: item.kind,
        version: item.version,
      };
    })
    .filter((app) => app.id.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
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
  await recordOrigin(id, `clone:${appId}`);
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
  try {
    const origins = await readOrigins();
    if (id in origins) {
      delete origins[id];
      await appStorage.save(ORIGINS_PATH, JSON.stringify(origins, null, 2));
    }
  } catch {
    /* best effort — loadProjects prunes anything left behind */
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
