import { createMemo, For, onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { appStorage, defineApp } from '@bundled/yaar';
import './styles/index';

import { state, setState } from './store';
import { loadSessions, loadDetail, readBlob } from './api';
import { getDateKey, formatDateLabel, providerLabel, toPlain } from './utils';
import { SessionItem, DetailEmpty, DetailView } from './components';
import { narrow, sidebarVisible, toggleSidebar, closeDrawer, watchViewport } from './ui';
import { selectTurns, compactTurn, indexSession } from './select';
import type { SessionSummary } from './types';

/** Default and ceiling for one `readTurns` page. A page is a budget, not a preference. */
const TURNS_DEFAULT = 40;
const TURNS_MAX = 200;
/** Default and ceiling for `readBlob` / `readTranscript`, in characters. */
const CHARS_DEFAULT = 4000;
const CHARS_MAX = 40000;
/** How much of the transcript the `transcript` state key answers with before pointing at the command. */
const TRANSCRIPT_PEEK = 4000;

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The loaded session, or a refusal that names the way in. */
function requireSelected(): string {
  const id = state.selectedId;
  if (!id) throw new Error('No session loaded. Call selectSession({ sessionId }) first.');
  return id;
}

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
      // `toPlain` is not optional here: state.sessions is a store proxy and the
      // postMessage hop out of the iframe cannot clone one. See utils.toPlain.
      get: () =>
        state.sessions.length
          ? {
              currentSessionId: state.currentSessionId || null,
              total: state.sessions.length,
              sessions: toPlain(state.sessions) ?? [],
            }
          : null,
    },
    selectedSession: {
      description: 'Currently selected session detail object',
      get: () => toPlain(state.detail),
    },
    transcript: {
      description:
        "Head of the selected session's markdown transcript, with its total size. " +
        'Read further with readTranscript({ offset, limit }).',
      get: () => {
        const full = state.transcript;
        if (full == null) return null;
        if (full.length <= TRANSCRIPT_PEEK)
          return { chars: full.length, complete: true, text: full };
        return {
          chars: full.length,
          complete: false,
          text: full.slice(0, TRANSCRIPT_PEEK),
          note: `Showing the first ${TRANSCRIPT_PEEK} of ${full.length} characters. Continue with readTranscript({ offset: ${TRANSCRIPT_PEEK} }).`,
        };
      },
    },
    // An index, deliberately — not the turns.
    //
    // This used to return every parsed entry, which made a session unreadable rather
    // than large: one logged session here holds 6874 of them, and a state getter takes
    // no arguments, so there was no smaller question to ask. Orientation (what is in
    // here) and retrieval (give me these forty) are different questions; only the
    // second one should cost an agent anything, and it is `readTurns` that answers it.
    messages: {
      description:
        'Index of the selected session: total, type/agent/tool histograms, error and blob ' +
        'counts. Not the turns themselves — read those with readTurns.',
      get: () => (state.messages ? indexSession(state.messages) : null),
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
    // The three reads below are what the `messages` and `transcript` state keys cannot
    // be: a state getter takes no arguments, so every question it answers is the same
    // size. A command takes parameters, which is the only place in this app's surface
    // where "how much" can be said at all.
    readTurns: {
      description:
        "Read a page of the loaded session's turns, optionally filtered. Each result carries " +
        'its `index` in the full log, so readTurns({ offset: index - 3, limit: 7 }) re-reads a ' +
        'hit with its neighbours. A result too large to inline comes back as `blob` ' +
        '({ sha256, bytes, preview }) — fetch the bytes with readBlob.',
      replay: 'never',
      params: {
        type: 'object',
        properties: {
          offset: {
            type: 'number',
            description:
              'Where to start within the *filtered* set (0-based). With no filter this is the ' +
              'index in the full log. Negative counts back from the end: -20 is the last 20.',
          },
          limit: {
            type: 'number',
            description: `How many turns to return (default ${TURNS_DEFAULT}, max ${TURNS_MAX}).`,
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Keep only these entry types: user, assistant, thinking, tool_use, tool_result, ' +
              'verb_result, action, interaction.',
          },
          agentId: { type: 'string', description: 'Keep only this agent id (exact).' },
          toolName: {
            type: 'string',
            description:
              'Keep only tools whose name contains this — "read" finds mcp__verbs__read.',
          },
          search: {
            type: 'string',
            description:
              'Case-insensitive substring over content, tool input, interaction and blob preview.',
          },
          errorsOnly: { type: 'boolean', description: 'Keep only failed results.' },
          blobsOnly: {
            type: 'boolean',
            description: 'Keep only turns whose result was offloaded.',
          },
          maxChars: {
            type: 'number',
            description:
              'Per-turn budget for content and tool input (default 600). A clipped turn is ' +
              'flagged `truncated`.',
          },
        },
      },
      run: async (params) => {
        const sessionId = requireSelected();
        if (!state.messages) {
          throw new Error(state.messagesError ?? 'Session turns are still loading — retry.');
        }
        const limit = clampInt(params.limit, TURNS_DEFAULT, 1, TURNS_MAX);
        const maxChars = clampInt(params.maxChars, 600, 0, 20000);
        const filter = {
          types: Array.isArray(params.types) ? params.types.map(String) : undefined,
          agentId: params.agentId == null ? undefined : String(params.agentId),
          toolName: params.toolName == null ? undefined : String(params.toolName),
          search: params.search == null ? undefined : String(params.search),
          errorsOnly: params.errorsOnly === true,
          blobsOnly: params.blobsOnly === true,
        };
        const hits = selectTurns(state.messages, filter);
        // A negative offset counts back from the end — asking for "the last 20" without
        // first having to learn how many there are.
        const raw = clampInt(params.offset, 0, -hits.length, Math.max(hits.length, 0));
        const offset = raw < 0 ? Math.max(0, hits.length + raw) : Math.min(raw, hits.length);
        const page = hits.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          sessionId,
          total: state.messages.length,
          matched: hits.length,
          offset,
          count: page.length,
          nextOffset: nextOffset < hits.length ? nextOffset : null,
          turns: page.map((t) => compactTurn(t, maxChars)),
        };
      },
    },
    readBlob: {
      description:
        "Read the content behind a turn's `blob.sha256` — a result the log offloaded because " +
        'it exceeded 2KB. Returns a character window, not the whole thing. A blob that is ' +
        'JSON comes back pretty-printed, so `chars` is the length of that rendering and will ' +
        "not equal the turn's `blob.bytes` on disk.",
      replay: 'never',
      params: {
        type: 'object',
        properties: {
          sha256: { type: 'string', description: "The hash from a turn's `blob.sha256`." },
          offset: { type: 'number', description: 'Character offset to start at (default 0).' },
          limit: {
            type: 'number',
            description: `Characters to return (default ${CHARS_DEFAULT}, max ${CHARS_MAX}).`,
          },
        },
        required: ['sha256'],
      },
      run: async (params) => {
        const sessionId = requireSelected();
        const sha256 = String(params.sha256 ?? '').trim();
        // Checked here as well as server-side: a hash that is not a hash resolves to
        // "blob not found", which reads like missing data rather than a bad argument.
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          throw new Error('"sha256" must be the 64-character hex digest from a turn\'s `blob`.');
        }
        const full = await readBlob(sessionId, sha256);
        const offset = clampInt(params.offset, 0, 0, full.length);
        const limit = clampInt(params.limit, CHARS_DEFAULT, 1, CHARS_MAX);
        const text = full.slice(offset, offset + limit);
        const nextOffset = offset + text.length;
        return {
          sha256,
          chars: full.length,
          offset,
          returned: text.length,
          nextOffset: nextOffset < full.length ? nextOffset : null,
          text,
        };
      },
    },
    readTranscript: {
      description:
        "Read a character window of the loaded session's markdown transcript. The `transcript` " +
        'state key answers with the head; this reads the rest.',
      replay: 'never',
      params: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Character offset to start at (default 0).' },
          limit: {
            type: 'number',
            description: `Characters to return (default ${CHARS_DEFAULT}, max ${CHARS_MAX}).`,
          },
        },
      },
      run: async (params) => {
        requireSelected();
        const full = state.transcript;
        if (full == null) throw new Error('Transcript is still loading — retry.');
        const offset = clampInt(params.offset, 0, 0, full.length);
        const limit = clampInt(params.limit, CHARS_DEFAULT, 1, CHARS_MAX);
        const text = full.slice(offset, offset + limit);
        const nextOffset = offset + text.length;
        return {
          chars: full.length,
          offset,
          returned: text.length,
          nextOffset: nextOffset < full.length ? nextOffset : null,
          text,
        };
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
      // A write, not state restoration: replaying it on an iframe remount would rewrite
      // a report nobody asked for a second time.
      replay: 'never',
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
