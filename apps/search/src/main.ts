export {};
import { For, Show, createMemo } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';
import type { SearchMatch } from './types';
import { state, setState } from './store';
import { performSearch, selectResult, cloneApp, clearSearch, registerProtocol, setOnPreviewLoaded } from './protocol';
import { showToast } from '@bundled/yaar';

let previewBodyEl: HTMLDivElement | undefined;

// ── Helpers ──────────────────────────────────────────────────────────────────

function highlightMatch(text: string, pattern: string): unknown[] {
  try {
    const re = new RegExp(pattern, 'gi');
    const parts: unknown[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
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
function groupByFile(matches: SearchMatch[]): Map<string, { matches: SearchMatch[]; startIndex: number }> {
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
        ${() => state.searching ? '…' : 'Go'}
      </button>
    </div>
    <button class="y-btn y-btn-sm" onClick=${openCloneDialog} title="Clone app source into storage">Clone</button>
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
        <div class="preview-body" ref=${(el: HTMLDivElement) => { previewBodyEl = el; }}>
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

render(App, document.getElementById('app')!);

// ── Init ─────────────────────────────────────────────────────────────────────

registerProtocol();

setOnPreviewLoaded(() => {
  if (!previewBodyEl) return;
  const highlighted = previewBodyEl.querySelector('.preview-line.highlighted');
  if (highlighted) highlighted.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
