import { createMemo, For, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { appStorage, defineApp } from '@bundled/yaar';
import './styles/index';

import { state, setState } from './store';
import { loadSessions, loadDetail } from './api';
import { getDateKey, formatDateLabel, providerLabel } from './utils';
import { SessionItem, DetailEmpty, DetailView } from './components';
import { narrow, sidebarVisible, toggleSidebar, closeDrawer, watchViewport } from './ui';
import type { SessionSummary } from './types';

// --- Computed ---
const filteredSessions = createMemo(() => {
  const q = state.search.toLowerCase();
  if (!q) return state.sessions;
  return state.sessions.filter(
    (s) =>
      s.sessionId.toLowerCase().includes(q) || providerLabel(s.provider).toLowerCase().includes(q),
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
    .map(
      ([date, items]) =>
        [
          date,
          items.slice().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
        ] as [string, SessionSummary[]],
    );
});

// --- Root component ---
function Root() {
  onMount(() => {
    loadSessions();
  });
  onCleanup(watchViewport());

  const bodyCls = () =>
    `body${narrow() ? ' narrow' : ''}${sidebarVisible() ? '' : ' sidebar-hidden'}`;

  return html`
  <div class="layout">

    <div class="app-header">
      <button
        class="y-btn y-btn-sm y-btn-ghost sidebar-toggle"
        onClick=${toggleSidebar}
        title="Toggle session list"
      >
        ${() => (sidebarVisible() ? '❮' : '☰')}
      </button>
      <span class="app-title">Session Logs</span>
      ${() =>
        state.totalCount > 0
          ? html`<span class="count-badge">${state.totalCount} sessions</span>`
          : null}
      <button class="y-btn y-btn-sm y-btn-ghost refresh-btn" onClick=${loadSessions}>
        ${() => (state.loading ? html`<span class="y-spinner"></span>` : html`<span>↻</span>`)}
      </button>
    </div>

    <div class=${bodyCls}>

      <div class="sidebar">
        <div class="search-wrap">
          <input
            class="y-input search-input"
            placeholder="Search by ID or provider..."
            onInput=${(e: InputEvent) => setState('search', (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="session-list">
          ${() =>
            state.loading && state.sessions.length === 0
              ? html`<div class="list-status"><span class="y-spinner"></span></div>`
              : null}
          ${() =>
            !state.loading && state.sessions.length === 0 && state.loadError
              ? html`<div class="list-status list-error">⚠️ ${state.loadError}</div>`
              : null}
          ${() =>
            !state.loading && filteredSessions().length === 0 && !state.loadError
              ? html`<div class="list-status">No sessions found</div>`
              : null}

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

      <div class="drawer-scrim" onClick=${closeDrawer}></div>

      <div class="detail-panel">
        ${() => {
          if (!state.selectedId) return DetailEmpty();
          if (state.detailLoading)
            return html`
              <div class="detail-loading"><span class="y-spinner y-spinner-lg"></span></div>
            `;
          if (state.detail) return DetailView();
          return DetailEmpty();
        }}
      </div>

    </div>
  </div>
  `;
}

export default defineApp({
  id: 'session-logs',
  name: 'Session Logs',
  state: {
    sessions: {
      description: 'List of session summaries (id, provider, date, agentCount)',
      get: () =>
        state.sessions.length
          ? {
              currentSessionId: state.currentSessionId || null,
              total: state.sessions.length,
              sessions: state.sessions,
            }
          : null,
    },
    selectedSession: {
      description: 'Currently selected session detail object',
      get: () => state.detail,
    },
    transcript: {
      description: 'Markdown transcript of the selected session',
      get: () => state.transcript,
    },
    messages: {
      description: 'Structured parsed messages array for the selected session',
      get: () =>
        state.messages ? { count: state.messages.length, messages: state.messages } : null,
    },
  },
  commands: {
    selectSession: {
      description: 'Select and load a session by ID (loads transcript and messages)',
      params: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID to load' },
        },
        required: ['sessionId'],
      },
      run: async (params) => {
        const sessionId = String(params.sessionId);
        await loadDetail(sessionId);
        return { success: true, sessionId };
      },
    },
    refresh: {
      description: 'Reload the session list from disk',
      params: { type: 'object', properties: {} },
      run: async () => {
        await loadSessions();
        return { success: true, count: state.sessions.length };
      },
    },
    // The agent's only route to storage. It used to write audits with the built-in
    // `command('storage:write', …)`, which is no longer offered to an app whose app.json
    // declares no storage permission — this app's does not, and the built-in reaching its
    // own tree regardless was the capability that gate closed. A declared command is the
    // intended shape: the iframe holds the SDK (`yaar://apps/self/storage/` is granted for
    // being an app), the agent asks for the write by name, and the app decides where
    // reports may land.
    saveReport: {
      description:
        'Save an analysis report into this app\'s own storage under "reports/". ' +
        'Returns the storage URI it was written to.',
      params: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'File name, e.g. "audit-2026-08-12.md". A ".md" suffix is added if missing; ' +
              'path separators are not allowed.',
          },
          content: { type: 'string', description: 'Report body (markdown)' },
        },
        required: ['name', 'content'],
      },
      run: async (params) => {
        const raw = String(params.name ?? '').trim();
        if (!raw) throw new Error('"name" is required.');
        if (/[\\/]/.test(raw) || raw.includes('..')) {
          throw new Error('"name" is a file name, not a path — reports all live in "reports/".');
        }
        const content = String(params.content ?? '');
        if (!content) throw new Error('"content" is required.');
        const file = raw.endsWith('.md') ? raw : `${raw}.md`;
        const path = `reports/${file}`;
        await appStorage.save(path, content);
        return { success: true, path, uri: `yaar://apps/session-logs/storage/${path}` };
      },
    },
  },
  view: Root,
});
