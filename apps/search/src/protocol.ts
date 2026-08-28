export {};
import { appStorage, invoke, del, list, storage, errMsg } from '@bundled/yaar';
import { state, setState } from './store';
import { isGeneratedPath } from './paths';
import type { SearchResult, SearchMatch } from './types';

/** Cloned source is private to Search; ordinary searches continue to use shared storage. */
const CLONE_ROOT = 'apps-source';

function cleanPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function isClonePath(path: string): boolean {
  const clean = cleanPath(path);
  return clean === CLONE_ROOT || clean.startsWith(`${CLONE_ROOT}/`);
}

/** Keep custom clone destinations inside Search's private clone tree. */
export function clonePath(path: string): string {
  const clean = cleanPath(path);
  if (clean.split('/').includes('..')) throw new Error('Clone path cannot escape apps-source.');
  if (!clean) return CLONE_ROOT;
  return isClonePath(clean) ? clean : `${CLONE_ROOT}/${clean}`;
}

/** Match the JavaScript RegExp contract used by Dev Tools' grep command. */
export function validateSearchPattern(pattern: string): void {
  new RegExp(pattern);
}

/**
 * Phrase the result of one search, given what survived filtering and what did not.
 *
 * Pure and shared by the statusbar and the protocol return so the UI and an agent are
 * never told different things about the same search. `notes` is the honest half: an
 * empty result after filtering is NOT the same answer as no match anywhere, and
 * reporting it as one sends the caller looking for a string they already found.
 */
export function describeSearch(
  matchCount: number,
  excluded: number,
  truncated: boolean,
): { status: string; notes: string[] } {
  const plural = matchCount === 1 ? '' : 'es';
  let status = `${matchCount} match${plural}`;
  if (excluded > 0) status += ` (+${excluded} generated hidden)`;
  if (truncated) status += ' (truncated)';

  const notes: string[] = [];
  if (matchCount === 0 && excluded > 0) {
    notes.push(
      `No matches in source. ${excluded} match(es) were in generated output — pass includeBuilt: true to see them.`,
    );
  } else if (excluded > 0) {
    notes.push(`${excluded} match(es) in generated output skipped — pass includeBuilt for those.`);
  }
  if (truncated) {
    notes.push(
      excluded > 0
        ? 'Storage capped the raw match list BEFORE generated output was filtered out, so source matches may be missing entirely — narrow the scope or glob rather than trusting this count.'
        : 'Storage capped the match list — narrow the scope or glob to see the rest.',
    );
  }
  return { status, notes };
}

export async function performSearch(
  pattern: string,
  glob?: string,
  scope?: string,
  includeBuilt = false,
) {
  if (!pattern) return;
  setState('searching', true);
  setState('includeBuilt', includeBuilt);
  setState('excluded', 0);
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
    validateSearchPattern(pattern);
    const normalizedScope = cleanPath(scope ?? '');
    const uri = normalizedScope
      ? isClonePath(normalizedScope)
        ? `yaar://apps/self/storage/${normalizedScope}`
        : `yaar://storage/${normalizedScope}`
      : 'yaar://storage/';
    const payload: Record<string, unknown> = { action: 'grep', pattern };
    if (glob) payload.glob = glob;
    const result = await invoke<SearchResult>(uri, payload);
    // The filter runs here and not on the server: the storage grep action takes one
    // positive glob and no exclusions, so a negative filter cannot be expressed as a
    // query. Paths are scope-relative, which is deliberate — see isGeneratedPath.
    const raw = result.matches ?? [];
    const kept = includeBuilt ? raw : raw.filter((m) => !isGeneratedPath(m.file));
    const truncated = result.truncated ?? false;
    setState('matches', kept);
    setState('excluded', raw.length - kept.length);
    setState('truncated', truncated);
    setState('statusText', describeSearch(kept.length, raw.length - kept.length, truncated).status);
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('matches', []);
    setState('excluded', 0);
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
    const path = fullPath(match.file);
    const content = isClonePath(path)
      ? await appStorage.read(path)
      : await storage.read(path, { as: 'text' });
    setState('previewContent', typeof content === 'string' ? content : String(content));
  } catch {
    setState('previewContent', '(unable to read file)');
  }
  requestAnimationFrame(() => _onPreviewLoaded?.());
}

// ── Result normalization ─────────────────────────────────────────────────────

/** Max matches embedded in a single protocol payload. */
export const RESULTS_CAP = 500;

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

export function sliceMatches(offset: number, limit: number) {
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
    id = id
      .replace(/^yaar:\/\/apps\//, '')
      .replace(/\/+$/, '')
      .trim();
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
        destPath: r.destPath ?? `${CLONE_ROOT}/${appId}`,
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
  const target = clonePath(path || CLONE_ROOT);
  setState('statusText', `Purging ${target}…`);
  try {
    await del(`yaar://apps/self/storage/${target}`);
    setState('statusText', `Purged Search storage/${target}/`);
    return { success: true, path: target };
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('statusText', `Purge error: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function cloneApp(appId: string, destPath?: string): Promise<CloneOutcome> {
  const dest = clonePath(destPath || appId);
  setState('statusText', `Cloning ${appId}…`);
  try {
    const result = await invoke<{
      files?: { path: string; content: string; encoding?: 'base64' }[];
      meta?: { name: string; icon: string; description: string };
    }>(`yaar://apps/${appId}`, { action: 'clone' });
    if (!result.files?.length) {
      setState('statusText', `Clone failed: no source files found`);
      return { success: false, error: 'no source files found' };
    }
    let written = 0;
    for (const file of result.files) {
      // The clone verb marks binary files (.glb, .png, fonts) with encoding 'base64' and
      // sends their bytes encoded. Saving that string without passing the flag back stores
      // the base64 TEXT -- a file 4/3 the real size that no loader can parse.
      const options = file.encoding === 'base64' ? { encoding: 'base64' as const } : undefined;
      await appStorage.save(`${dest}/${file.path}`, file.content, options);
      written++;
    }
    setState('statusText', `Cloned ${appId}: ${written} files → Search storage/${dest}/`);
    return { success: true, filesWritten: written, destPath: dest };
  } catch (e: unknown) {
    const msg = errMsg(e);
    setState('statusText', `Clone error: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function removeClone(appId: string, destPath?: string) {
  const dest = clonePath(destPath || appId);
  setState('statusText', `Removing ${dest}…`);
  try {
    await del(`yaar://apps/self/storage/${dest}`);
    setState('statusText', `Removed Search storage/${dest}/`);
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
  setState('excluded', 0);
  setState('truncated', false);
  setState('selectedIndex', null);
  setState('previewPath', null);
  setState('previewContent', null);
  setState('previewHighlightLine', null);
  setState('statusText', 'Ready');
}
