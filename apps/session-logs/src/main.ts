import { createSignal, createMemo, For, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { readJson } from '@bundled/yaar';
import type { SessionSummary, SessionListResult, SessionDetail } from './types';
import './styles.css';

// --- State ---
const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
const [currentSessionId, setCurrentSessionId] = createSignal('');
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [detail, setDetail] = createSignal<SessionDetail | null>(null);
const [loading, setLoading] = createSignal(false);
const [detailLoading, setDetailLoading] = createSignal(false);
const [search, setSearch] = createSignal('');
const [totalCount, setTotalCount] = createSignal(0);

// --- Data loading ---
async function loadSessions() {
  setLoading(true);
  try {
    // BUG FIX: listJson does not exist in @bundled/yaar and returns wrong format.
    // yaar://sessions/ returns a JSON object, so we must use readJson.
    const result = await readJson<SessionListResult>('yaar://sessions/');
    setSessions(result.sessions ?? []);
    setCurrentSessionId(result.currentSessionId ?? '');
    setTotalCount(result.count ?? result.sessions?.length ?? 0);
  } catch (e) {
    console.error('Failed to load sessions', e);
  } finally {
    setLoading(false);
  }
}

async function loadDetail(sessionId: string) {
  setSelectedId(sessionId);
  setDetail(null);
  setDetailLoading(true);
  try {
    const d = await readJson<SessionDetail>(`yaar://sessions/${sessionId}`);
    // Ensure sessionId is present even if the endpoint doesn't return it
    if (!d.sessionId) (d as Record<string, unknown>).sessionId = sessionId;
    setDetail(d);
  } catch (e) {
    console.error('Failed to load detail', e);
    // Fallback: use summary data from the list
    const s = sessions().find(s => s.sessionId === sessionId);
    if (s) setDetail(s as unknown as SessionDetail);
  } finally {
    setDetailLoading(false);
  }
}

// --- Format helpers ---

/** YYYY-MM-DD HH:MM in local time */
function formatDateTime(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${min}`;
  } catch { return '-'; }
}

/** Full datetime with seconds for detail view */
function formatFull(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${min}:${sec}`;
  } catch { return '-'; }
}

/** Human-readable duration between two ISO timestamps */
function durationBetween(a: string | undefined, b: string | undefined): string {
  if (!a || !b) return '-';
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (isNaN(ms) || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const mn = Math.floor(s / 60);
    if (mn < 60) return `${mn}m ${s % 60}s`;
    const h = Math.floor(mn / 60);
    return `${h}h ${mn % 60}m`;
  } catch { return '-'; }
}

/** YYYY-MM-DD date key from createdAt (with sessionId fallback) */
function getDateKey(s: SessionSummary): string {
  if (s.createdAt) {
    try {
      const d = new Date(s.createdAt);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch { /* fall through */ }
  }
  const match = s.sessionId.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : 'unknown';
}

/** Friendly date group label */
function formatDateLabel(dateStr: string): string {
  if (dateStr === 'unknown') return 'Unknown Date';
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const yesterdayStr = `${yest.getFullYear()}-${pad(yest.getMonth()+1)}-${pad(yest.getDate())}`;
  if (dateStr === todayStr) return `Today  ${y}.${pad(m)}.${pad(d)}`;
  if (dateStr === yesterdayStr) return `Yesterday  ${y}.${pad(m)}.${pad(d)}`;
  return `${y}.${pad(m)}.${pad(d)}`;
}

/** Canonical display label for provider */
function providerLabel(p: string | undefined): string {
  if (!p) return 'unknown';
  return p.trim() || 'unknown';
}

/** CSS class string for provider badge */
function providerCls(p: string | undefined): string {
  const slug = providerLabel(p).toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `provider-badge provider-${slug}`;
}

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

// --- Components ---

const SessionItem = (s: SessionSummary) => {
  const isActive  = () => selectedId() === s.sessionId;
  const isCurrent = () => currentSessionId() === s.sessionId;

  // BUG FIX: wrap static class strings in functions so Solid's html template
  // sets them correctly; also avoids stale closure issues.
  return html`
    <div
      class=${() =>
        `session-item${isActive() ? ' active' : ''}${isCurrent() ? ' current-session' : ''}`
      }
      onClick=${() => loadDetail(s.sessionId)}
    >
      <div class="session-id">
        ${() => isCurrent() ? '⚡\u00a0' + s.sessionId : s.sessionId}
      </div>
      <div class="session-meta">
        <span class=${() => providerCls(s.provider)}>${() => providerLabel(s.provider)}</span>
        <span class="session-datetime">${() => formatDateTime(s.createdAt)}</span>
        <span class="agent-count">🤖 ${() => s.agentCount ?? 0}</span>
      </div>
    </div>
  `;
};

const DetailEmpty = () => html`
  <div class="detail-empty">
    <div class="empty-icon">📋</div>
    <div class="empty-title">No session selected</div>
    <div class="empty-sub">Click a session in the list to view its details</div>
  </div>
`;

const DetailView = () => {
  const d = detail();
  if (!d) return null;

  const sid      = selectedId() ?? '';
  const isCurrent = currentSessionId() === sid;

  // Extra keys beyond the known ones go into the raw section
  const knownKeys = new Set(['sessionId','createdAt','lastActivity','provider','agentCount']);
  const extraEntries = Object.entries(d).filter(([k]) => !knownKeys.has(k));

  return html`
    <div class="detail-content">

      <div class="detail-header">
        <div class="detail-session-id">${d.sessionId ?? sid}</div>
        ${isCurrent ? html`<span class="current-chip">⚡ Current Session</span>` : null}
      </div>

      <div class="detail-grid">

        <div class="detail-field">
          <div class="field-label">Provider</div>
          <div class="field-value">
            <span class=${providerCls(d.provider)}>${providerLabel(d.provider)}</span>
          </div>
        </div>

        <div class="detail-field">
          <div class="field-label">Agents</div>
          <div class="field-value agent-value">🤖 ${d.agentCount ?? '-'}</div>
        </div>

        <div class="detail-field">
          <div class="field-label">Created</div>
          <div class="field-value mono">${formatFull(d.createdAt)}</div>
        </div>

        <div class="detail-field">
          <div class="field-label">Last Activity</div>
          <div class="field-value mono">${formatFull(d.lastActivity)}</div>
        </div>

        <div class="detail-field span-2">
          <div class="field-label">Duration</div>
          <div class="field-value">⏱ ${durationBetween(d.createdAt, d.lastActivity)}</div>
        </div>

      </div>

      ${extraEntries.length > 0 ? html`
        <div class="raw-section">
          <div class="raw-section-title">Extra Fields</div>
          <pre class="raw-json">${JSON.stringify(
            Object.fromEntries(extraEntries), null, 2
          )}</pre>
        </div>
      ` : null}

      <div class="raw-section">
        <div class="raw-section-title">Raw JSON</div>
        <pre class="raw-json">${JSON.stringify(d, null, 2)}</pre>
      </div>

    </div>
  `;
};

// --- Root render ---
render(() => html`
  <div class="layout">

    <div class="app-header">
      <span class="app-title">📋 Session Logs</span>
      ${() => totalCount() > 0
        ? html`<span class="count-badge">${totalCount()} sessions</span>`
        : null
      }
      <button class="y-btn y-btn-sm y-btn-ghost refresh-btn" onClick=${loadSessions}>
        ${() => loading()
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
              setSearch((e.target as HTMLInputElement).value)
            }
          />
        </div>

        <div class="session-list">
          ${() => loading() && sessions().length === 0
            ? html`<div class="list-status"><span class="y-spinner"></span></div>`
            : null
          }
          ${() => !loading() && filteredSessions().length === 0
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
