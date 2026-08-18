export {};
import { For, Show, createMemo } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import './styles/index';
import type { SearchMatch } from './types';
import { state, setState } from './store';
import {
  performSearch,
  selectResult,
  cloneApp,
  cloneApps,
  purgeClones,
  removeClone,
  clearSearch,
  setOnPreviewLoaded,
  sliceMatches,
  RESULTS_CAP,
  validateSearchPattern,
} from './protocol';
import { AppCommandError, errMsg, showToast, defineApp } from '@bundled/yaar';
import { analyzeDeps, getLastDepsReport } from './deps';

let previewBodyEl: HTMLDivElement | undefined;

// ── Helpers ──────────────────────────────────────────────────────────────────

function highlightMatch(text: string, pattern: string): unknown[] {
  try {
    const re = new RegExp(pattern, 'gi');
    const parts: unknown[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push(html`<span class="match-highlight">${m[0]}</span>`);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : [text];
  } catch {
    return [text];
  }
}

function getFileIcon(file: string): string {
  if (file.endsWith('.ts') || file.endsWith('.tsx')) return '🟦';
  if (file.endsWith('.js') || file.endsWith('.jsx')) return '🟨';
  if (file.endsWith('.json')) return '📋';
  if (file.endsWith('.md')) return '📝';
  if (file.endsWith('.css')) return '🎨';
  if (file.endsWith('.html')) return '🌐';
  return '📄';
}

/** Group matches by file, preserving order of first appearance. */
function groupByFile(
  matches: SearchMatch[],
): Map<string, { matches: SearchMatch[]; startIndex: number }> {
  const groups = new Map<string, { matches: SearchMatch[]; startIndex: number }>();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const existing = groups.get(m.file);
    if (existing) {
      existing.matches.push(m);
    } else {
      groups.set(m.file, { matches: [m], startIndex: i });
    }
  }
  return groups;
}

// ── Search trigger ───────────────────────────────────────────────────────────

function triggerSearch() {
  const pattern = state.query.trim();
  if (!pattern) return;
  performSearch(pattern, state.glob || undefined, state.scope || undefined);
}

function handleSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') triggerSearch();
}

// ── Clone dialog ─────────────────────────────────────────────────────────────

function openCloneDialog() {
  setState('cloneAppId', '');
  setState('cloneDestPath', '');
  setState('showCloneDialog', true);
}

function closeCloneDialog() {
  setState('showCloneDialog', false);
}

async function submitClone(e: Event) {
  e.preventDefault();
  const appId = state.cloneAppId.trim();
  if (!appId) return;
  closeCloneDialog();
  const result = await cloneApp(appId, state.cloneDestPath.trim() || undefined);
  if (result.success) {
    showToast(`Cloned ${appId}`, 'success');
  } else {
    showToast(`Clone failed: ${result.error ?? 'unknown error'}`, 'error');
  }
}

// ── Close preview ────────────────────────────────────────────────────────────

function closePreview() {
  setState('selectedIndex', null);
  setState('previewPath', null);
  setState('previewContent', null);
  setState('previewHighlightLine', null);
}

// ── Template ─────────────────────────────────────────────────────────────────

const grouped = createMemo(() => [...groupByFile(state.matches).entries()]);

const App = () => html`
  <div class="toolbar">
    <div class="scope-crumb">
      ${() => {
        const parts = state.scope ? state.scope.split('/').filter(Boolean) : [];
        const crumbs: any[] = [
          html`<button onClick=${() => setState('scope', '')}>storage/</button>`,
        ];
        let accumulated = '';
        for (const part of parts) {
          accumulated += (accumulated ? '/' : '') + part;
          const p = accumulated;
          crumbs.push(html`<span class="sep">/</span>`);
          crumbs.push(html`<button onClick=${() => setState('scope', p)}>${part}</button>`);
        }
        return crumbs;
      }}
    </div>
    <div class="search-inputs">
      <input
        class="pattern-input y-input"
        placeholder="Search pattern (regex)"
        value=${() => state.query}
        onInput=${(e: InputEvent) => setState('query', (e.target as HTMLInputElement).value)}
        onKeydown=${handleSearchKeydown}
      />
      <input
        class="glob-input y-input"
        placeholder="*.ts"
        title="File glob filter"
        value=${() => state.glob}
        onInput=${(e: InputEvent) => setState('glob', (e.target as HTMLInputElement).value)}
        onKeydown=${handleSearchKeydown}
      />
      <button class="y-btn y-btn-sm y-btn-primary" onClick=${triggerSearch}
        disabled=${() => state.searching}>
        ${() => (state.searching ? '…' : 'Go')}
      </button>
    </div>
    <button class="y-btn y-btn-sm" onClick=${openCloneDialog} title="Clone app source into Search storage">Clone</button>
    <button class="y-btn y-btn-sm" onClick=${clearSearch} title="Clear results">Clear</button>
  </div>

  <div class="main">
    ${() => {
      if (state.matches.length === 0 && !state.searching) {
        return html`
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <div>${state.statusText === 'Ready' ? 'Enter a pattern to search storage' : state.statusText}</div>
          </div>
        `;
      }
      return html`
        <div class="results y-scroll">
          <${For} each=${grouped}>
            ${(entry: [string, { matches: SearchMatch[]; startIndex: number }]) => {
              const [file, group] = entry;
              return html`
                <div class="result-file-group">
                  <div class="result-file-header">
                    <span class="file-icon">${getFileIcon(file)}</span>
                    <span>${file}</span>
                  </div>
                  <${For} each=${() => group.matches}>
                    ${(match: SearchMatch, idx: () => number) => {
                      const globalIdx = group.startIndex + idx();
                      return html`
                        <div
                          class=${() => `result-row${state.selectedIndex === globalIdx ? ' selected' : ''}`}
                          onClick=${() => selectResult(globalIdx)}
                        >
                          <span class="result-line-num">${match.line}</span>
                          <span class="result-content">${() => highlightMatch(match.content, state.query)}</span>
                        </div>
                      `;
                    }}
                  <//>
                </div>
              `;
            }}
          <//>
        </div>
      `;
    }}

    <${Show} when=${() => state.previewPath}>
      <div class="preview">
        <div class="preview-header">
          <span class="y-truncate">${() => state.previewPath ?? ''}</span>
          <button class="preview-close" onClick=${closePreview}>✕</button>
        </div>
        <div class="preview-body" ref=${(el: HTMLDivElement) => {
          previewBodyEl = el;
        }}>
          ${() => {
            const content = state.previewContent;
            if (!content) return null;
            const lines = content.split('\n');
            const hl = state.previewHighlightLine;
            return html`
              <${For} each=${() => lines}>
                ${(line: string, idx: () => number) => {
                  const lineNum = idx() + 1;
                  return html`
                    <span class=${`preview-line${lineNum === hl ? ' highlighted' : ''}`}>
                      <span class="ln">${lineNum}</span>${line}
                    </span>
                  `;
                }}
              <//>
            `;
          }}
        </div>
      </div>
    <//>
  </div>

  <${Show} when=${() => state.showCloneDialog}>
    <div class="modal-overlay" onClick=${(e: MouseEvent) => {
      if (e.target === e.currentTarget) closeCloneDialog();
    }}>
      <div class="modal-card y-card">
        <div class="modal-title">Clone App Source</div>
        <form class="modal-form" onSubmit=${submitClone}>
          <label class="modal-label y-text-xs y-text-muted">App ID</label>
          <input class="modal-input y-input" placeholder="memo" required
            value=${() => state.cloneAppId}
            onInput=${(e: InputEvent) => setState('cloneAppId', (e.target as HTMLInputElement).value)} />
          <label class="modal-label y-text-xs y-text-muted">Destination path (optional)</label>
          <input class="modal-input y-input" placeholder="apps-source/{appId}"
            value=${() => state.cloneDestPath}
            onInput=${(e: InputEvent) => setState('cloneDestPath', (e.target as HTMLInputElement).value)} />
          <div class="modal-actions">
            <button class="y-btn y-btn-sm" type="button" onClick=${closeCloneDialog}>Cancel</button>
            <button class="y-btn y-btn-sm y-btn-primary" type="submit">Clone</button>
          </div>
        </form>
      </div>
    </div>
  <//>

  <div class="statusbar">${() => state.statusText}</div>
`;

// ── Init ─────────────────────────────────────────────────────────────────────

setOnPreviewLoaded(() => {
  if (!previewBodyEl) return;
  const highlighted = previewBodyEl.querySelector('.preview-line.highlighted');
  if (highlighted) highlighted.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

export default defineApp({
  id: 'search',
  name: 'Search',
  state: {
    query: {
      description: 'Current search pattern',
      get: () => state.query || null,
    },
    results: {
      description:
        'Current search results: { matches, total, returned, offset, capped, truncated }. Each match is a plain object with path, line, content, appId. Capped at 500 — use the get-results command for paging beyond that.',
      get: () => {
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
      get: () => {
        if (state.selectedIndex == null) return null;
        const m = state.matches[state.selectedIndex];
        return m ? { file: m.file, line: m.line, content: m.content } : null;
      },
    },
    preview: {
      description: 'File preview content with highlighted line',
      get: () =>
        state.previewPath
          ? {
              path: state.previewPath,
              content: state.previewContent,
              highlightLine: state.previewHighlightLine,
            }
          : null,
    },
    deps: {
      description:
        'The last analyze-deps report (mode, root, stats, and the mode-specific data). Null until analyze-deps runs.',
      get: () => getLastDepsReport(),
    },
  },
  commands: {
    search: {
      description: 'Run regex search across storage',
      params: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          glob: {
            type: 'string',
            description:
              'File glob filter. No "/" means match that name at any depth ("*.ts"); ' +
              'with a "/" it matches the path from the scope root ("apps/**/*.ts").',
          },
          scope: { type: 'string', description: 'Directory scope within storage' },
        },
        required: ['pattern'],
      },
      run: async (params) => {
        const pattern = String(params.pattern);
        try {
          validateSearchPattern(pattern);
        } catch (e) {
          throw new AppCommandError(errMsg(e));
        }
        setState('query', pattern);
        if (params.glob) setState('glob', String(params.glob));
        if (params.scope != null) setState('scope', String(params.scope));
        await performSearch(
          pattern,
          params.glob as string | undefined,
          params.scope as string | undefined,
        );
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
      run: async (params) => {
        await selectResult(Number(params.index));
        return { success: true };
      },
    },
    'get-results': {
      description: 'Read search results with offset/limit paging',
      params: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Zero-based start index (default 0)' },
          limit: { type: 'number', description: 'Max matches to return (default 100, max 500)' },
        },
      },
      run: (params) => {
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
    },
    'clone-app': {
      description:
        'Clone one or more app sources into Search’s private storage. appId accepts a plain id, a glob ("*" for every app, "dc-*"), or an array of either. Apps without src/ are skipped rather than failing the batch.',
      params: {
        type: 'object',
        properties: {
          appId: {
            description:
              'App id, glob pattern, or array of ids/globs. "*" clones every installed app.',
          },
          destPath: {
            type: 'string',
            description:
              'Destination within Search’s private apps-source/ tree (single app only; default: apps-source/{appId}).',
          },
        },
        required: ['appId'],
      },
      run: async (params) => {
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
    },
    'purge-clones': {
      description:
        'Remove all cloned app sources from Search’s private storage (default: the entire apps-source/ tree).',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to purge (default: apps-source)' },
        },
      },
      run: async (params) => {
        return await purgeClones(params.path ? String(params.path) : undefined);
      },
    },
    'remove-clone': {
      description: 'Remove a previously cloned app source from Search’s private storage',
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
      run: async (params) => {
        return await removeClone(String(params.appId), params.destPath as string | undefined);
      },
    },
    'analyze-deps': {
      description:
        'Analyze source dependencies of a cloned app. `path` is a clone path ("memo" or "apps-source/memo") — clone-app must have run first — or a yaar://storage/… directory. Regex import parsing, no AST. Modes: cycles (circular imports), impact (what a file affects), summary (fan-in/out, entry points, orphans), mermaid (focused diagram; focus and depth are required).',
      params: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Cloned source root: "memo", "apps-source/memo", or a yaar://storage/… directory.',
          },
          mode: {
            type: 'string',
            enum: ['cycles', 'impact', 'summary', 'mermaid'],
            description: 'cycles | impact | summary | mermaid',
          },
          focus: {
            type: 'string',
            description:
              'File to centre on, relative to the root ("src/store.ts"). Required for impact and mermaid.',
          },
          depth: {
            type: 'number',
            description: 'Hops around focus, 1-4. Required for mermaid.',
          },
          direction: {
            type: 'string',
            enum: ['dependents', 'dependencies', 'both'],
            description:
              'impact only: who reaches focus (default), what focus reaches, or both (labelled separately).',
          },
          includeTypeOnly: {
            type: 'boolean',
            description: 'Include `import type` edges. Default false — they inflate the graph.',
          },
          externals: {
            type: 'string',
            enum: ['exclude', 'leaf'],
            description: 'Bare package imports: excluded (default) or kept as leaf nodes.',
          },
          limit: { type: 'number', description: 'summary only: top-N rows. Default 10, max 50.' },
          refresh: {
            type: 'boolean',
            description: 'Re-read files instead of using the cached graph.',
          },
        },
        required: ['path', 'mode'],
      },
      run: async (params) => {
        return await analyzeDeps(params as Record<string, unknown>);
      },
    },
    clear: {
      description: 'Clear search results and preview',
      params: { type: 'object', properties: {} },
      run: () => {
        clearSearch();
        return { success: true };
      },
    },
  },
  view: App,
});
