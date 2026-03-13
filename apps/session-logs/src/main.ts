import { createSignal, createMemo, For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { listJson, readJson } from '@bundled/yaar';
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
    const result = await listJson<SessionListResult>('yaar://sessions/');
    setSessions(result.sessions ?? []);
    setCurrentSessionId(result.currentSessionId ?? '');
    setTotalCount(result.count ?? 0);
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
    setDetail(d);
  } catch (e) {
    console.error('Failed to load detail', e);
    // Fallback: use summary data
    const s = sessions().find(s => s.sessionId === sessionId);
    if (s) setDetail(s as unknown as SessionDetail);
  } finally {
    setDetailLoading(false);
  }
}

// --- Computed ---
const filteredSessions = createMemo(() => {
  const q = search().toLowerCase();
  if (!q) return sessions();
  return sessions().filter(s =>
    s.sessionId.includes(q) || s.provider.includes(q)
  );
});

// Group sessions by date (YYYY-MM-DD)
const groupedSessions = createMemo(() => {
  const groups: Record<string, SessionSummary[]> = {};
  for (const s of filteredSessions()) {
    const date = s.sessionId.slice(0, 10); // "2026-03-13"
    if (!groups[date]) groups[date] = [];
    groups[date].push(s);
  }
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
});

// --- Format helpers ---
function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return iso; }
}

function formatDateLabel(dateStr: string) {
  const parts = dateStr.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const yest = new Date(now); yest.setDate(now.getDate()-1);
  const yesterdayStr = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`;
  if (dateStr === today) return `Today - ${y}.${m}.${d}`;
  if (dateStr === yesterdayStr) return `Yesterday - ${y}.${m}.${d}`;
  return `${y}.${m}.${d}`;
}

function formatFull(iso: string) {
  try {
    return new Date(iso).toLocaleString('ko-KR');
  } catch { return iso; }
}

function durationBetween(a: string, b: string) {
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const mn = Math.floor(s / 60);
    if (mn < 60) return `${mn}m ${s % 60}s`;
    const h = Math.floor(mn / 60);
    return `${h}h ${mn % 60}m`;
  } catch { return '-'; }
}

// --- UI Components ---
onMount(() => {
  loadSessions();
});

const SessionItem = (s: SessionSummary) => {
  const isActive = () => selectedId() === s.sessionId;
  const isCurrent = () => currentSessionId() === s.sessionId;
  return html`
    <div
      class=${() => `session-item ${isActive() ? 'active' : ''} ${isCurrent() ? 'current-session' : ''}`}
      onClick=${() => loadDetail(s.sessionId)}
    >
      <div class="session-id">${() => isCurrent() ? '⚡ ' + s.sessionId : s.sessionId}</div>
      <div class="session-meta">
        <span class=${`provider-badge provider-${s.provider}`}>${s.provider}</span>
        <span>${formatTime(s.createdAt)}</span>
        <span class="agent-dot">🤖 ${s.agentCount}</span>
      </div>
    </div>
  `;
};

const DetailEmpty = () => html`
  <div class="detail-empty">
    <div class="icon">📋</div>
    <div style="font-size:13px">Select a session</div>
    <div style="font-size:11px">Click a session in the list to view its details</div>
  </div>
`;

const DetailView = () => {
  const d = detail();
  if (!d) return null;
  const sessionId = selectedId() ?? '';
  const isCurrent = currentSessionId() === sessionId;

  const extraKeys = Object.keys(d).filter(k =>
    !['sessionId','createdAt','lastActivity','provider','agentCount'].includes(k)
  );
  const extraData = extraKeys.length > 0
    ? Object.fromEntries(extraKeys.map(k => [k, (d as Record<string, unknown>)[k]]))
    : null;

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <div class="detail-session-id">${d.sessionId}</div>
        ${isCurrent ? html`<div class="current-chip">Current Session</div>` : null}
      </div>

      <div class="detail-grid">
        <div class="detail-field">
          <div class="field-label">Provider</div>
          <div class="field-value">
            <span class=${`provider-badge provider-${d.provider}`}>${d.provider}</span>
          </div>
        </div>
        <div class="detail-field">
          <div class="field-label">Agents</div>
          <div class="field-value">🤖 ${d.agentCount ?? '-'}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Created</div>
          <div class="field-value" style="font-size:12px">${formatFull(d.createdAt)}</div>
        </div>
        <div class="detail-field">
          <div class="field-label">Last Activity</div>
          <div class="field-value" style="font-size:12px">${formatFull(d.lastActivity)}</div>
        </div>
        <div class="detail-field" style="grid-column: span 2">
          <div class="field-label">Duration</div>
          <div class="field-value">⏱ ${durationBetween(d.createdAt, d.lastActivity)}</div>
        </div>
      </div>

      ${extraData ? html`
        <div class="raw-section">
          <div class="raw-section-title">Extra Data</div>
          <pre class="raw-json">${JSON.stringify(extraData, null, 2)}</pre>
        </div>
      ` : null}

      <div class="raw-section">
        <div class="raw-section-title">Raw JSON</div>
        <pre class="raw-json">${JSON.stringify(d, null, 2)}</pre>
      </div>
    </div>
  `;
};

render(() => html`
  <div class="layout">
    <!-- Header -->
    <div class="header">
      <h1>📋 Session Logs</h1>
      ${() => totalCount() > 0 ? html`<span class="count-badge">${totalCount()} sessions</span>` : null}
      <button class="y-btn y-btn-sm y-btn-ghost" onClick=${loadSessions} title="Refresh">
        ${() => loading() ? html`<span class="y-spinner"></span>` : '↻'}
      </button>
    </div>

    <!-- Body -->
    <div class="body">
      <!-- Sidebar -->
      <div class="sidebar">
        <div class="search-wrap">
          <input
            class="y-input"
            placeholder="Search sessions..."
            style="font-size:12px"
            onInput=${(e: InputEvent) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="session-list">
          ${() => loading() && sessions().length === 0
            ? html`<div class="no-results"><span class="y-spinner"></span></div>`
            : null
          }
          ${() => !loading() && filteredSessions().length === 0
            ? html`<div class="no-results">No results found</div>`
            : null
          }
          <${For} each=${groupedSessions}>
            ${([date, items]: [string, SessionSummary[]]) => html`
              <div>
                <div class="date-group-label">${formatDateLabel(date)}</div>
                <${For} each=${items}>
                  ${(s: SessionSummary) => SessionItem(s)}
                </${For}>
              </div>
            `}
          </${For}>
        </div>
      </div>

      <!-- Detail Panel -->
      <div class="detail-panel">
        ${() => {
          if (!selectedId()) return DetailEmpty();
          if (detailLoading()) return html`<div class="detail-loading"><span class="y-spinner"></span></div>`;
          if (detail()) return DetailView();
          return DetailEmpty();
        }}
      </div>
    </div>
  </div>
`, document.getElementById('app')!);
