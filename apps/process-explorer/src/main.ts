export {};

import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { TabId, AgentEntry, WindowInfo, BrowserTab } from './types';
import {
  agentStats,
  agentList,
  windows,
  browsers,
  lastRefresh,
  startPolling,
  refreshAll,
  interruptAgent,
  closeWindow,
  closeBrowser,
} from './data';
import { registerProtocol } from './protocol';
import './styles.css';

// ── State ────────────────────────────────────────────────────

const [activeTab, setActiveTab] = createSignal<TabId>('agents');

// ── Helpers ──────────────────────────────────────────────────

function typeBadge(type: AgentEntry['type']) {
  const colors: Record<string, string> = {
    monitor: 'var(--yaar-accent)',
    app: 'var(--yaar-success)',
    ephemeral: 'var(--yaar-text-muted)',
    session: '#f5a623',
  };
  return colors[type] ?? 'var(--yaar-text-muted)';
}

function formatTime(date: Date | null) {
  if (!date) return '--';
  return date.toLocaleTimeString();
}

// ── Components ───────────────────────────────────────────────

function StatsBar() {
  const stats = () => agentStats();
  return html`
    <div class="stats-bar">
      <div
        class=${() => `stat-card y-card${activeTab() === 'agents' ? ' active' : ''}`}
        onClick=${() => setActiveTab('agents')}
      >
        <div class="stat-value">${() => stats()?.totalAgents ?? 0}</div>
        <div class="stat-label">Agents</div>
        <div class="stat-sub">${() => (stats()?.busyAgents ?? 0) + ' busy'}</div>
      </div>
      <div
        class=${() => `stat-card y-card${activeTab() === 'windows' ? ' active' : ''}`}
        onClick=${() => setActiveTab('windows')}
      >
        <div class="stat-value">${() => windows().length}</div>
        <div class="stat-label">Windows</div>
        <div class="stat-sub">${() => {
          const locked = windows().filter((w) => w.locked).length;
          return locked > 0 ? locked + ' locked' : 'none locked';
        }}</div>
      </div>
      <div
        class=${() => `stat-card y-card${activeTab() === 'browsers' ? ' active' : ''}`}
        onClick=${() => setActiveTab('browsers')}
      >
        <div class="stat-value">${() => browsers().length}</div>
        <div class="stat-label">Browsers</div>
        <div class="stat-sub">tabs</div>
      </div>
    </div>
  `;
}

function AgentRow(props: { agent: AgentEntry }) {
  const a = () => props.agent;
  const dotClass = () => {
    if (a().busy) return 'dot dot-warn';
    if (a().type === 'ephemeral') return 'dot dot-warn';
    return 'dot dot-ok';
  };

  return html`
    <div class="process-row">
      <div class="process-info">
        <span class=${dotClass}></span>
        <div class="process-detail">
          <div class="process-title">${() => a().id}</div>
          <div class="process-meta">
            <span style=${() => `color: ${typeBadge(a().type)}`}>${() => a().type}</span>
          </div>
        </div>
      </div>
      <div class="process-actions">
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => interruptAgent(a().id)}
          title="Interrupt"
        >
          Stop
        </button>
      </div>
    </div>
  `;
}

function AgentList() {
  return html`
    <${Show}
      when=${() => agentList().length > 0}
      fallback=${html`<div class="y-empty"><div class="y-empty-icon">~</div>No agents running</div>`}
    >
      <${For} each=${agentList}>${(agent: AgentEntry) => html`<${AgentRow} agent=${agent} />`}</>
    </>
  `;
}

function WindowRow(props: { win: WindowInfo }) {
  const w = () => props.win;
  return html`
    <div class="process-row">
      <div class="process-info">
        <div class="process-detail">
          <div class="process-title">
            ${() => w().locked ? html`<span class="lock-icon">&#128274; </span>` : null}${() =>
              w().title || '(untitled)'}
          </div>
          <div class="process-meta">
            <span class="y-badge">${() => w().renderer}</span>
            ${() => (w().appId ? html` <span class="y-badge">${w().appId}</span>` : null)}
            <span> ${() => w().size}</span>
          </div>
        </div>
      </div>
      <div class="process-actions">
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => closeWindow(w().id)}
          title="Close window"
        >
          Close
        </button>
      </div>
    </div>
  `;
}

function WindowList() {
  return html`
    <${Show}
      when=${() => windows().length > 0}
      fallback=${html`<div class="y-empty"><div class="y-empty-icon">&#9633;</div>No windows open</div>`}
    >
      <${For} each=${windows}>${(win: WindowInfo) => html`<${WindowRow} win=${win} />`}</>
    </>
  `;
}

function BrowserRow(props: { tab: BrowserTab }) {
  const t = () => props.tab;
  return html`
    <div class="process-row">
      <div class="process-info">
        <span class="dot dot-ok"></span>
        <div class="process-detail">
          <div class="process-title">${() => t().title || '(no title)'}</div>
          <div class="process-meta">${() => t().url}</div>
        </div>
      </div>
      <div class="process-actions">
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => closeBrowser(t().id)}
          title="Close tab"
        >
          Close
        </button>
      </div>
    </div>
  `;
}

function BrowserList() {
  return html`
    <${Show}
      when=${() => browsers().length > 0}
      fallback=${html`<div class="y-empty"><div class="y-empty-icon">&#127760;</div>No browser tabs</div>`}
    >
      <${For} each=${browsers}>${(tab: BrowserTab) => html`<${BrowserRow} tab=${tab} />`}</>
    </>
  `;
}

function StatusBar() {
  return html`
    <div class="status-bar">
      <span>Last refresh: ${() => formatTime(lastRefresh())}</span>
      <button class="y-btn y-btn-ghost btn-sm" onClick=${() => refreshAll()}>Refresh</button>
    </div>
  `;
}

function App() {
  onMount(() => {
    startPolling();
    registerProtocol();
  });

  return html`
    <div class="pe-app">
      <${StatsBar} />
      <div class="tab-content">
        <${Show} when=${() => activeTab() === 'agents'}><${AgentList} /></>
        <${Show} when=${() => activeTab() === 'windows'}><${WindowList} /></>
        <${Show} when=${() => activeTab() === 'browsers'}><${BrowserList} /></>
      </div>
      <${StatusBar} />
    </div>
  `;
}

render(App, document.getElementById('app')!);
