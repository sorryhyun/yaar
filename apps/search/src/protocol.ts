export {};
import { app, invoke, del, storage } from '@bundled/yaar';
import { state, setState } from './store';
import type { SearchResult } from './types';

export async function performSearch(pattern: string, glob?: string, scope?: string) {
  if (!pattern) return;
  setState('searching', true);
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
    const msg = e instanceof Error ? e.message : String(e);
    setState('matches', []);
    setState('statusText', `Error: ${msg}`);
  } finally {
    setState('searching', false);
  }
}

/** Callback set by main.ts to scroll preview after content loads. */
let _onPreviewLoaded: (() => void) | null = null;
export function setOnPreviewLoaded(fn: () => void) { _onPreviewLoaded = fn; }

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

export async function cloneApp(appId: string, destPath?: string) {
  const dest = destPath || `apps-source/${appId}`;
  setState('statusText', `Cloning ${appId}…`);
  try {
    const result = await invoke<{ files?: { path: string; content: string }[]; meta?: { name: string; icon: string; description: string } }>(`yaar://apps/${appId}`, { action: 'clone' });
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
    const msg = e instanceof Error ? e.message : String(e);
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
    const msg = e instanceof Error ? e.message : String(e);
    setState('statusText', `Remove error: ${msg}`);
    return { success: false, error: msg };
  }
}

export function clearSearch() {
  setState('query', '');
  setState('glob', '');
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
        description: 'Current search results: { matches, truncated }',
        handler: () =>
          state.matches.length
            ? { matches: state.matches, truncated: state.truncated, total: state.matches.length }
            : null,
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
      search: {
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
        handler: async (params: Record<string, unknown>) => {
          const pattern = String(params.pattern);
          setState('query', pattern);
          if (params.glob) setState('glob', String(params.glob));
          if (params.scope != null) setState('scope', String(params.scope));
          await performSearch(pattern, params.glob as string, params.scope as string);
          return {
            success: true,
            matchCount: state.matches.length,
            truncated: state.truncated,
          };
        },
      },
      select: {
        description: 'Select a search result by index to preview the file',
        params: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'Zero-based result index' },
          },
          required: ['index'],
        },
        handler: async (params: Record<string, unknown>) => {
          await selectResult(Number(params.index));
          return { success: true };
        },
      },
      'clone-app': {
        description: 'Clone an app source into storage for inspection',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App ID to clone (e.g. "memo")' },
            destPath: {
              type: 'string',
              description: 'Destination path in storage (default: apps-source/{appId})',
            },
          },
          required: ['appId'],
        },
        handler: async (params: Record<string, unknown>) => {
          return await cloneApp(String(params.appId), params.destPath as string | undefined);
        },
      },
      'remove-clone': {
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
        handler: async (params: Record<string, unknown>) => {
          return await removeClone(String(params.appId), params.destPath as string | undefined);
        },
      },
      clear: {
        description: 'Clear search results and preview',
        params: { type: 'object', properties: {} },
        handler: () => {
          clearSearch();
          return { success: true };
        },
      },
    },
  });
}
