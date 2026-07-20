export {};
import { app, defineCommand, invoke, del, list, storage, errMsg } from '@bundled/yaar';
import { state, setState } from './store';
import type { SearchResult, SearchMatch } from './types';

export async function performSearch(pattern: string, glob?: string, scope?: string) {
  if (!pattern) return;
  setState('searching', true);
  // Record the scope these results are actually relative to. Using the UI's
  // `scope` for path reconstruction is wrong: a protocol-driven search may pass
  // no scope while a stale `scope` from an earlier search is still in the store.
  setState('resultScope', (scope ?? '').replace(/^\/+|\/+$/g, ''));
  setState('statusText', 'Searching…');
  setState('selectedIndex', null);
  setState('previewPath', null);
  setState('previewContent', null);
  setState('previewHighlightLine', null);
  try {
    const uri = scope ? `yaar://storage/${scope}` : 'yaar://storage/';
    const payload: Record<string, unknown> = { action: 'grep', pattern };
    if (glob) payload.glob = glob;
    const result = await invoke<SearchResult>(uri, payload);
    setState('matches', result.matches ?? []);
    setState('truncated', result.truncated ?? false);
    const count = result.matches?.length ?? 0;
    const suffix = result.truncated ? ' (truncated to 100)' : '';
    setState('statusText', `${count} match${count !== 1 ? 'es' : ''}${suffix}`);
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('matches', []);
    setState('statusText', `Error: ${msg}`);
  } finally {
    setState('searching', false);
  }
}

/** Callback set by main.ts to scroll preview after content loads. */
let _onPreviewLoaded: (() => void) | null = null;
export function setOnPreviewLoaded(fn: () => void) {
  _onPreviewLoaded = fn;
}

export async function selectResult(index: number) {
  const match = state.matches[index];
  if (!match) return;
  setState('selectedIndex', index);
  setState('previewHighlightLine', match.line);
  setState('previewPath', match.file);
  try {
    const content = await storage.read(match.file, { as: 'text' });
    setState('previewContent', typeof content === 'string' ? content : String(content));
  } catch {
    setState('previewContent', '(unable to read file)');
  }
  requestAnimationFrame(() => _onPreviewLoaded?.());
}

// ── Result normalization ─────────────────────────────────────────────────────

/** Max matches embedded in a single protocol payload. */
const RESULTS_CAP = 500;

/**
 * Grep returns paths relative to the search scope, so a scoped search yields
 * "memo/src/x.ts" rather than "apps-source/memo/src/x.ts". Re-attach the scope
 * so callers get a path they can actually read back.
 */
function fullPath(file: string): string {
  const scope = state.resultScope;
  if (!scope) return file;
  return file === scope || file.startsWith(`${scope}/`) ? file : `${scope}/${file}`;
}

/** Derive the app id from a cloned-source path: apps-source/memo/src/x.ts → memo. */
function appIdFromPath(file: string): string | null {
  const m = /^apps-source\/([^/]+)(?:\/|$)/.exec(file);
  return m ? m[1] : null;
}

/**
 * Rebuild a store match as a plain, structured-cloneable object.
 *
 * `state.matches` is a Solid createStore array, i.e. a Proxy. Handing its
 * elements to postMessage throws DataCloneError, which is exactly what made
 * the `results` state unreadable. Every protocol payload must be rebuilt from
 * primitives like this rather than passing store values through.
 */
function toPlainMatch(m: SearchMatch) {
  const path = fullPath(m.file);
  return {
    path,
    file: m.file,
    line: m.line,
    content: m.content,
    appId: appIdFromPath(path),
  };
}

function sliceMatches(offset: number, limit: number) {
  const total = state.matches.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.max(start, Math.min(start + limit, total));
  const items: ReturnType<typeof toPlainMatch>[] = [];
  for (let i = start; i < end; i++) items.push(toPlainMatch(state.matches[i]));
  return { items, total, offset: start };
}

// ── App id resolution / globbing ─────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

type AppListEntry = { uri?: string; id?: string; appId?: string; name?: string };

/**
 * List installed app ids. The verb layer has returned several shapes over time
 * (bare array, { items }, { apps }, plain string ids), so accept all of them
 * rather than silently expanding a glob to nothing.
 */
async function listAppIds(): Promise<string[]> {
  const res = await list<unknown>('yaar://apps/');
  const raw: unknown = Array.isArray(res)
    ? res
    : ((res as { items?: unknown[]; apps?: unknown[] })?.items ??
      (res as { items?: unknown[]; apps?: unknown[] })?.apps ??
      []);
  const ids: string[] = [];
  for (const entry of (raw as unknown[]) ?? []) {
    let id: string | undefined;
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      const e = entry as AppListEntry;
      id = e.appId ?? e.id ?? e.uri;
    }
    if (!id) continue;
    id = id.replace(/^yaar:\/\/apps\//, '').replace(/\/+$/, '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Expand specs (plain ids and/or globs) into a deduped list of app ids. */
async function resolveAppIds(spec: string | string[]): Promise<string[]> {
  const specs = Array.isArray(spec) ? spec.map(String) : [String(spec)];
  const needsList = specs.some((s) => s.includes('*') || s.includes('?'));
  const available = needsList ? await listAppIds() : [];
  const out: string[] = [];
  for (const s of specs) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (trimmed.includes('*') || trimmed.includes('?')) {
      const re = globToRegExp(trimmed);
      for (const id of available) if (re.test(id) && !out.includes(id)) out.push(id);
    } else if (!out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

export interface CloneOutcome {
  success: boolean;
  filesWritten?: number;
  destPath?: string;
  error?: string;
}

export interface BatchCloneSummary {
  success: boolean;
  requested: number;
  cloned: { appId: string; filesWritten: number; destPath: string }[];
  skipped: { appId: string; reason: string }[];
}

/** Clone many apps, skipping (not failing on) the ones without src/. */
export async function cloneApps(spec: string | string[]): Promise<BatchCloneSummary> {
  const ids = await resolveAppIds(spec);
  const cloned: BatchCloneSummary['cloned'] = [];
  const skipped: BatchCloneSummary['skipped'] = [];
  for (let i = 0; i < ids.length; i++) {
    const appId = ids[i];
    setState('statusText', `Cloning ${appId} (${i + 1}/${ids.length})…`);
    const r = await cloneApp(appId);
    if (r.success) {
      cloned.push({
        appId,
        filesWritten: r.filesWritten ?? 0,
        destPath: r.destPath ?? `apps-source/${appId}`,
      });
    } else {
      skipped.push({ appId, reason: r.error ?? 'unknown error' });
    }
  }
  setState('statusText', `Cloned ${cloned.length}, skipped ${skipped.length}`);
  return { success: true, requested: ids.length, cloned, skipped };
}

/** Remove every cloned app source in one call. */
export async function purgeClones(path?: string) {
  const target = path || 'apps-source';
  setState('statusText', `Purging ${target}…`);
  try {
    await del(`yaar://storage/${target}`);
    setState('statusText', `Purged storage/${target}/`);
    return { success: true, path: target };
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('statusText', `Purge error: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function cloneApp(appId: string, destPath?: string): Promise<CloneOutcome> {
  const dest = destPath || `apps-source/${appId}`;
  setState('statusText', `Cloning ${appId}…`);
  try {
    const result = await invoke<{
      files?: { path: string; content: string }[];
      meta?: { name: string; icon: string; description: string };
    }>(`yaar://apps/${appId}`, { action: 'clone' });
    if (!result.files?.length) {
      setState('statusText', `Clone failed: no source files found`);
      return { success: false, error: 'no source files found' };
    }
    let written = 0;
    for (const file of result.files) {
      await storage.save(`${dest}/${file.path}`, file.content);
      written++;
    }
    setState('statusText', `Cloned ${appId}: ${written} files → storage/${dest}/`);
    return { success: true, filesWritten: written, destPath: dest };
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('statusText', `Clone error: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function removeClone(appId: string, destPath?: string) {
  const dest = destPath || `apps-source/${appId}`;
  setState('statusText', `Removing ${dest}…`);
  try {
    await del(`yaar://storage/${dest}`);
    setState('statusText', `Removed storage/${dest}/`);
    return { success: true, path: dest };
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('statusText', `Remove error: ${msg}`);
    return { success: false, error: msg };
  }
}

export function clearSearch() {
  setState('query', '');
  setState('glob', '');
  setState('resultScope', '');
  setState('matches', []);
  setState('truncated', false);
  setState('selectedIndex', null);
  setState('previewPath', null);
  setState('previewContent', null);
  setState('previewHighlightLine', null);
  setState('statusText', 'Ready');
}

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'search',
    name: 'Search',
    state: {
      query: {
        description: 'Current search pattern',
        handler: () => state.query || null,
      },
      results: {
        description:
          'Current search results: { matches, total, returned, offset, capped, truncated }. Each match is a plain object with path, line, content, appId. Capped at 500 — use the get-results command for paging beyond that.',
        handler: () => {
          if (!state.matches.length) return null;
          const { items, total } = sliceMatches(0, RESULTS_CAP);
          return {
            matches: items,
            total,
            returned: items.length,
            offset: 0,
            capped: total > items.length,
            truncated: state.truncated,
          };
        },
      },
      selected: {
        description: 'Currently selected result match',
        handler: () => {
          if (state.selectedIndex == null) return null;
          const m = state.matches[state.selectedIndex];
          return m ? { file: m.file, line: m.line, content: m.content } : null;
        },
      },
      preview: {
        description: 'File preview content with highlighted line',
        handler: () =>
          state.previewPath
            ? {
                path: state.previewPath,
                content: state.previewContent,
                highlightLine: state.previewHighlightLine,
              }
            : null,
      },
    },
    commands: {
      search: defineCommand({
        description: 'Run regex search across storage',
        params: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
            scope: { type: 'string', description: 'Directory scope within storage' },
          },
          required: ['pattern'],
        },
        handler: async (params) => {
          const pattern = String(params.pattern);
          setState('query', pattern);
          if (params.glob) setState('glob', String(params.glob));
          if (params.scope != null) setState('scope', String(params.scope));
          await performSearch(pattern, params.glob, params.scope);
          return {
            success: true,
            matchCount: state.matches.length,
            truncated: state.truncated,
          };
        },
      }),
      select: defineCommand({
        description: 'Select a search result by index to preview the file',
        params: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'Zero-based result index' },
          },
          required: ['index'],
        },
        handler: async (params) => {
          await selectResult(Number(params.index));
          return { success: true };
        },
      }),
      'get-results': defineCommand({
        description: 'Read search results with offset/limit paging',
        params: {
          type: 'object',
          properties: {
            offset: { type: 'number', description: 'Zero-based start index (default 0)' },
            limit: { type: 'number', description: 'Max matches to return (default 100, max 500)' },
          },
        },
        handler: (params) => {
          const offset = Number(params.offset ?? 0) || 0;
          const rawLimit = Number(params.limit ?? 100) || 100;
          const limit = Math.max(1, Math.min(rawLimit, RESULTS_CAP));
          const { items, total, offset: start } = sliceMatches(offset, limit);
          return {
            matches: items,
            total,
            returned: items.length,
            offset: start,
            hasMore: start + items.length < total,
            truncated: state.truncated,
          };
        },
      }),
      'clone-app': defineCommand({
        description:
          'Clone one or more app sources into storage. appId accepts a plain id, a glob ("*" for every app, "dc-*"), or an array of either. Apps without src/ are skipped rather than failing the batch.',
        params: {
          type: 'object',
          properties: {
            appId: {
              description:
                'App id, glob pattern, or array of ids/globs. "*" clones every installed app.',
            },
            destPath: {
              type: 'string',
              description: 'Destination path (single app only, default: apps-source/{appId})',
            },
          },
          required: ['appId'],
        },
        handler: async (params) => {
          const spec = params.appId as string | string[];
          const isBatch =
            Array.isArray(spec) || String(spec).includes('*') || String(spec).includes('?');
          if (isBatch) return await cloneApps(spec);
          const appId = String(spec);
          const dest = params.destPath ? String(params.destPath) : undefined;
          const r = await cloneApp(appId, dest);
          return r.success
            ? {
                success: true,
                requested: 1,
                cloned: [
                  {
                    appId,
                    filesWritten: r.filesWritten ?? 0,
                    destPath: r.destPath ?? `apps-source/${appId}`,
                  },
                ],
                skipped: [],
              }
            : {
                success: false,
                requested: 1,
                cloned: [],
                skipped: [{ appId, reason: r.error ?? 'unknown error' }],
              };
        },
      }),
      'purge-clones': defineCommand({
        description:
          'Remove all cloned app sources in one call (default: the entire apps-source/ tree)',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to purge (default: apps-source)' },
          },
        },
        handler: async (params) => {
          return await purgeClones(params.path ? String(params.path) : undefined);
        },
      }),
      'remove-clone': defineCommand({
        description: 'Remove a previously cloned app source from storage',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App ID that was cloned (e.g. "memo")' },
            destPath: {
              type: 'string',
              description: 'Custom path used during clone (default: apps-source/{appId})',
            },
          },
          required: ['appId'],
        },
        handler: async (params) => {
          return await removeClone(String(params.appId), params.destPath);
        },
      }),
      clear: defineCommand({
        description: 'Clear search results and preview',
        params: { type: 'object', properties: {} },
        handler: () => {
          clearSearch();
          return { success: true };
        },
      }),
    },
  });
}
