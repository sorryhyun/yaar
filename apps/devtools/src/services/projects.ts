export {};
import { batch } from '@bundled/solid-js';
import { appStorage, invoke, list, del, errMsg, safeParseOr, subscribe } from '@bundled/yaar';
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
  setPreviewWindowId,
  setStaticProtocol,
  setStatusText,
  openTabs,
  setOpenTabs,
  sharedOpenFile,
  sharedOpenFileReady,
  setSharedOpenFile,
  type ProjectMeta,
} from '../core';
import { previewWindowIdFor, projectPath } from '../lib/paths';
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
 * Why `openPreview` calls this and not `loadProjects`: opening a project is a read;
 * previewing is what *creates* these trees, so it is what should retire them. Hanging
 * the sweep off the project listing meant deleting storage on a path that only meant to
 * populate a sidebar — and running it on every create, delete and tab switch, none of
 * which can have produced a new orphan.
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

/**
 * Which projects were open, and which one was in front.
 *
 * The projects themselves live in storage; *this* is the part that did not survive —
 * `openTabs` and `activeProject` are plain signals, so anything that reloads the iframe
 * empties them. That happens far more often than "the user closed the app": the desktop
 * replays a `window.create` for every window on reconnect, and a phone does it on every
 * return from another app. What the agent then sees is a devtools with no project open,
 * which is indistinguishable from a devtools that never had one — so it cloned the repo
 * again, under a new id, on top of the work that was already there.
 *
 * A sidecar at the appStorage root, alongside {@link ORIGINS_PATH} and for the same
 * reason: the projects' own `app.json` files are manifests that `deploy` ships.
 *
 * Deliberately *not* here: which file was open. It changes on every click in the tree,
 * and a write per click buys back the one piece of state the agent can rebuild for
 * itself by listing the project.
 */
const WORKSPACE_PATH = 'workspace.json';

interface Workspace {
  tabs: string[];
  activeId: string | null;
}

/**
 * Record the open set. Best effort, and not awaited by its callers: failing to write
 * this must never fail the open or close that produced it; losing it costs one restore.
 */
function saveWorkspace(): void {
  const workspace: Workspace = { tabs: openTabs(), activeId: activeProject()?.id ?? null };
  appStorage.save(WORKSPACE_PATH, JSON.stringify(workspace, null, 2)).catch((err) => {
    console.error('[devtools] recording open projects failed', err);
  });
}

/**
 * The stored open set, filtered against the live project list — a project deleted from
 * another window, or from a session whose last write never landed, would otherwise put
 * a tab on screen for a directory that is gone. Null when nothing usable is stored.
 */
async function readWorkspace(): Promise<{ tabs: string[]; activeId: string } | null> {
  const raw = await appStorage.readJsonOr<unknown>(WORKSPACE_PATH, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stored = raw as Partial<Workspace>;
  const live = new Set(projects().map((p) => p.id));
  const tabs = (Array.isArray(stored.tabs) ? stored.tabs : []).filter(
    (id): id is string => typeof id === 'string' && live.has(id),
  );
  if (tabs.length === 0) return null;
  const activeId =
    typeof stored.activeId === 'string' && tabs.includes(stored.activeId)
      ? stored.activeId
      : tabs[tabs.length - 1];
  return { tabs, activeId };
}

/**
 * Reopen what was open, once the project list is in. Nothing is written back here; the
 * next open or close does that.
 *
 * Opened as a follower: a copy mounting while another copy of this window is already
 * up must adopt that copy's build, preview and open file, not reset them. A window
 * that has just opened has nothing shared yet, so for it the two are the same.
 */
export async function restoreWorkspace(): Promise<void> {
  try {
    const workspace = await readWorkspace();
    if (!workspace) return;
    setOpenTabs(workspace.tabs);
    await openProject(workspace.activeId, { record: false });
  } catch (err) {
    // A workspace that cannot be read is not worth a status line: the user still has
    // every project in the picker, and the next open writes a good one.
    console.error('[devtools] restoring open projects failed', err);
  }
}

/**
 * Follow the open set when another copy of this window changes it.
 *
 * Every connected desktop mounts its own copy of Dev Tools, and the agent's commands reach
 * exactly one of them — the server pins one responder per window. With a phone and the
 * companion tab both attached, that one is the companion: `cloneApp` opened the clone
 * there, while the copy on the phone's screen kept showing the project from before, and
 * the user watched the agent build an app that was not the one on screen.
 *
 * A copy that follows does not write the set back, so two copies cannot ping-pong, and
 * each reads the file rather than trusting the ping — every copy lands on the last write.
 */
export function followWorkspace(): void {
  subscribe(`yaar://apps/self/storage/${WORKSPACE_PATH}`, () => {
    void syncWorkspace().catch((err) => {
      console.error('[devtools] following open projects failed', err);
    });
  }).catch((err) => {
    console.error('[devtools] watching open projects failed', err);
  });
}

async function syncWorkspace(): Promise<void> {
  const raw = await appStorage.readJsonOr<unknown>(WORKSPACE_PATH, undefined);
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Partial<Workspace>;
  const storedTabs = Array.isArray(stored.tabs) ? stored.tabs : [];
  const current = openTabs();
  // The ping for this copy's own write, the common case: nothing to do.
  if (
    (stored.activeId ?? null) === (activeProject()?.id ?? null) &&
    storedTabs.length === current.length &&
    storedTabs.every((id, i) => id === current[i])
  ) {
    return;
  }
  // A project cloned or created in another copy is one this copy has never listed.
  if (storedTabs.some((id) => !projects().some((p) => p.id === id))) await loadProjects();
  const workspace = await readWorkspace();
  if (!workspace) {
    if (activeProject()) clearActiveProjectState({ record: false });
    setOpenTabs([]);
    return;
  }
  setOpenTabs(workspace.tabs);
  if (workspace.activeId !== activeProject()?.id) {
    await openProject(workspace.activeId, { record: false });
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
      // writes last.
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

export async function createProject(name: string): Promise<{ id: string; appId: string }> {
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
  return { id, appId };
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
  const items =
    await list<
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
  /** The `appId` the cloned app.json carries — the id `deploy` expects. */
  appId: string;
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
  return { id, appId: typeof meta.appId === 'string' ? meta.appId : appId, agentsMd };
}

/**
 * Switch the active project.
 *
 * `record: false` is a copy following another copy of this window (or restoring).
 * It changes only what is this copy's own — the listing, the editor — and writes
 * nothing shared: the copy that switched already reset the shared build state and
 * picked the open file, and a follower writing them again could land after that
 * copy's next compile and erase it.
 */
export async function openProject(
  id: string,
  { record = true }: { record?: boolean } = {},
): Promise<void> {
  const proj = projects().find((p) => p.id === id);
  if (!proj) return;
  if (!openTabs().includes(id)) setOpenTabs([...openTabs(), id]);
  setActiveProject(proj);
  if (record) {
    batch(() => {
      // The static manifest belongs to whichever project was last compiled — drop it
      // on switch so the manifest command never reports another project's protocol.
      setStaticProtocol(null);
      // Same reasoning for the type-check verdict: it was reached about the project
      // being switched away from. `diagnostics` is left standing until the next
      // typecheck writes it, but `compileStatus` no longer reads it as current.
      setTypecheckState('unknown');
      // The preview binding is project-scoped in the same way. Both the window id and
      // the build URL describe the project being switched *away from*; left set,
      // `previewOpen` reports `open: true, stale: false` while
      // previewQuery/previewCommand/previewEval silently answer about a different app.
      // Unbind rather than close: the window belongs to the other project, and
      // openPreview already closes by id before it re-creates, so switching back cannot
      // collide.
      setPreviewUrl(null);
      setPreviewWindowId(null);
    });
  }
  await refreshFiles(id);
  if (record) {
    await openFile('src/main.ts');
    saveWorkspace();
    setStatusText(`Opened "${proj.name}"`);
    return;
  }
  // The copy that switched may have opened something other than main.ts by now. The
  // pointer may also still be loading, when this copy has only just mounted.
  await sharedOpenFileReady;
  const shared = sharedOpenFile();
  await openFile(shared?.projectId === id ? shared.path : 'src/main.ts', { share: false });
}

/**
 * Clear project-scoped UI state when no project remains open. `record: false` clears
 * only this copy's half, as in `openProject`.
 */
function clearActiveProjectState({ record = true }: { record?: boolean } = {}): void {
  batch(() => {
    setActiveProject(null);
    setFiles([]);
    setOpenFilePath(null);
    setOpenFileContent(null);
    setOpenFileImage(null);
    if (record) {
      setSharedOpenFile(null);
      setDiagnostics([]);
      setBundleStatus('idle');
      setTypecheckState('unknown');
      setPreviewUrl(null);
      setStaticProtocol(null);
    }
  });
  if (record) saveWorkspace();
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
    // The preview window is project-scoped too — its id is namespaced by project — and it
    // outlived the project it was showing: a window rendering a build whose source, whose
    // storage and whose entry in the sidebar are all gone. Nothing else closes it. Asked
    // by id rather than gated on `previewWindowId()`, since the project being deleted need
    // not be the active one and its window is a window all the same.
    await invoke(`yaar://windows/${previewWindowIdFor(id)}`, { action: 'close' });
  } catch {
    /* no preview window for this project — the normal case */
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
  setOpenTabs(openTabs().filter((t) => t !== id));
  if (activeProject()?.id === id) {
    const remaining = openTabs();
    if (remaining.length > 0) {
      await openProject(remaining[remaining.length - 1]);
    } else {
      clearActiveProjectState();
    }
  } else {
    saveWorkspace();
  }
  await loadProjects();
  setStatusText('Project deleted');
}

export function closeTab(id: string): void {
  const tabs = openTabs().filter((t) => t !== id);
  setOpenTabs(tabs);
  if (activeProject()?.id === id) {
    if (tabs.length > 0) {
      // Both branches record the new set themselves — `openProject` on its way out,
      // `clearActiveProjectState` likewise. Closing a *background* tab reaches neither.
      openProject(tabs[tabs.length - 1]);
      return;
    }
    clearActiveProjectState();
    return;
  }
  saveWorkspace();
}
