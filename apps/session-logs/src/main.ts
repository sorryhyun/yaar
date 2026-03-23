import { createMemo, For, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

import {
  sessions,
  selectedId,
  loading,
  detailLoading,
  detail,
  search,
  setSearch,
  totalCount,
  loadError,
} from './store';
import { loadSessions, loadDetail } from './api';
import { getDateKey, formatDateLabel, providerLabel, providerCls, formatDateTime } from './utils';
import { SessionItem, DetailEmpty, DetailView } from './components';
import type { SessionSummary } from './types';

// --- Computed ---
const filteredSessions = createMemo(() => {
  const q = search().toLowerCase();
  if (!q) return sessions();
  return sessions().filter(s =>
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
      <span class="app-title">&#x1F4CB; Session Logs</span>
      ${() => totalCount() > 0
        ? html`<span class="count-badge">${totalCount()} sessions</span>`
        : null
      }
      <button class="y-btn y-btn-sm y-btn-ghost refresh-btn" onClick=${loadSessions}>
        ${() => loading()
          ? html`<span class="y-spinner"></span>`
          : html`<span>&#x21BB;</span>`
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
              setSearch((e.target as HTMLInputElement).value)
            }
          />
        </div>

        <div class="session-list">
          ${() => loading() && sessions().length === 0
            ? html`<div class="list-status"><span class="y-spinner"></span></div>`
            : null
          }
          ${() => !loading() && sessions().length === 0 && loadError()
            ? html`<div class="list-status list-error">&#x26a0;&#xFE0F; ${loadError()}</div>`
            : null
          }
          ${() => !loading() && filteredSessions().length === 0 && !loadError()
            ? html`<div class="list-status">No sessions found</div>`
            : null
          }

          <${For} each=${groupedSessions}>
            ${([date, items]: [string, SessionSummary[]]) => html`
              <div class="date-group">
                <div class="date-group-label">${formatDateLabel(date)}</div>
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
          if (!selectedId()) return DetailEmpty();
          if (detailLoading()) return html`
            <div class="detail-loading"><span class="y-spinner y-spinner-lg"></span></div>
          `;
          if (detail()) return DetailView();
          return DetailEmpty();
        }}
      </div>

    </div>
  </div>
`, document.getElementById('app')!);
