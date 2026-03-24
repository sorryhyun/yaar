import { createMemo, For, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

import { state, setState } from './store';
import { loadSessions, loadDetail } from './api';
import { getDateKey, formatDateLabel, providerLabel, providerCls, formatDateTime } from './utils';
import { SessionItem, DetailEmpty, DetailView } from './components';
import type { SessionSummary } from './types';

// --- Computed ---
const filteredSessions = createMemo(() => {
  const q = state.search.toLowerCase();
  if (!q) return state.sessions;
  return state.sessions.filter(s =>
    s.sessionId.toLowerCase().includes(q) ||
    providerLabel(s.provider).toLowerCase().includes(q)
  );
});

const groupedSessions = createMemo(() => {
  const groups: Record<string, SessionSummary[]> = {};
  for (const s of filteredSessions()) {
    const key = getDateKey(s);
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  // Sort groups newest first; within each group sort newest first
  return Object.entries(groups)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => [
      date,
      items.slice().sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
      ),
    ] as [string, SessionSummary[]]);
});

// --- Mount ---
onMount(() => { loadSessions(); });

// --- Root render ---
render(() => html`
  <div class="layout">

    <div class="app-header">
      <span class="app-title">📋 Session Logs</span>
      ${() => state.totalCount > 0
        ? html`<span class="count-badge">${state.totalCount} sessions</span>`
        : null
      }
      <button class="y-btn y-btn-sm y-btn-ghost refresh-btn" onClick=${loadSessions}>
        ${() => state.loading
          ? html`<span class="y-spinner"></span>`
          : html`<span>↻</span>`
        }
      </button>
    </div>

    <div class="body">

      <div class="sidebar">
        <div class="search-wrap">
          <input
            class="y-input search-input"
            placeholder="Search by ID or provider..."
            onInput=${(e: InputEvent) =>
              setState('search', (e.target as HTMLInputElement).value)
            }
          />
        </div>

        <div class="session-list">
          ${() => state.loading && state.sessions.length === 0
            ? html`<div class="list-status"><span class="y-spinner"></span></div>`
            : null
          }
          ${() => !state.loading && state.sessions.length === 0 && state.loadError
            ? html`<div class="list-status list-error">⚠️ ${state.loadError}</div>`
            : null
          }
          ${() => !state.loading && filteredSessions().length === 0 && !state.loadError
            ? html`<div class="list-status">No sessions found</div>`
            : null
          }

          <${For} each=${groupedSessions}>
            ${([date, items]: [string, SessionSummary[]]) => html`
              <div class="date-group">
                <div class="y-label date-group-label">${formatDateLabel(date)}</div>
                <${For} each=${() => items}>
                  ${(s: SessionSummary) => SessionItem(s)}
                </${For}>
              </div>
            `}
          </${For}>
        </div>
      </div>

      <div class="detail-panel">
        ${() => {
          if (!state.selectedId) return DetailEmpty();
          if (state.detailLoading) return html`
            <div class="detail-loading"><span class="y-spinner y-spinner-lg"></span></div>
          `;
          if (state.detail) return DetailView();
          return DetailEmpty();
        }}
      </div>

    </div>
  </div>
`, document.getElementById('app')!);
