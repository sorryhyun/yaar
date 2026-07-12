export {};

import { onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { AgentEntry, WindowInfo, AppProcess } from './types';
import {
  agentStats,
  agentList,
  windows,
  appProcesses,
  lastRefresh,
  activeTab,
  selectTab,
  startWatching,
  refreshAll,
  interruptAgent,
  closeWindow,
  killAppAgent,
  closeAppWindows,
} from './data';
import { registerProtocol } from './protocol';
import './styles.css';

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
        onClick=${() => selectTab('agents')}
      >
        <div class="stat-value">${() => stats()?.totalAgents ?? 0}</div>
        <div class="stat-label">Agents</div>
        <div class="stat-sub">${() => (stats()?.busyAgents ?? 0) + ' busy'}</div>
      </div>
      <div
        class=${() => `stat-card y-card${activeTab() === 'windows' ? ' active' : ''}`}
        onClick=${() => selectTab('windows')}
      >
        <div class="stat-value">${() => windows().length}</div>
        <div class="stat-label">Windows</div>
        <div class="stat-sub">${() => {
          const locked = windows().filter((w) => w.locked).length;
          return locked > 0 ? locked + ' locked' : 'none locked';
        }}</div>
      </div>
      <div
        class=${() => `stat-card y-card${activeTab() === 'apps' ? ' active' : ''}`}
        onClick=${() => selectTab('apps')}
      >
        <div class="stat-value">${() => appProcesses().length}</div>
        <div class="stat-label">Apps</div>
        <div class="stat-sub">${() => {
          const orphaned = appProcesses().filter((p) => p.orphaned).length;
          return orphaned > 0 ? orphaned + ' orphaned' : 'none orphaned';
        }}</div>
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
          <div class="process-title">${() => a().label}</div>
          <div class="process-meta">
            <span style=${() => `color: ${typeBadge(a().type)}`}>${() => a().type}</span>
            <span>${() => (a().busy ? 'busy' : 'idle')}</span>
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
            ${() => (w().appId ? html`<span class="y-badge">${w().appId}</span>` : null)}
            <span>${() => w().size}</span>
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

function AppRow(props: { proc: AppProcess }) {
  const p = () => props.proc;

  const dotClass = () => {
    if (p().agent?.busy) return 'dot dot-warn';
    if (p().orphaned) return 'dot dot-warn';
    return 'dot dot-ok';
  };

  const agentLabel = () => {
    const agent = p().agent;
    if (!agent) return 'no agent';
    return agent.busy ? 'agent busy' : 'agent idle';
  };

  const windowLabel = () => {
    const n = p().windows.length;
    return n === 1 ? '1 window' : `${n} windows`;
  };

  return html`
    <div class="process-row">
      <div class="process-info">
        <span class=${dotClass}></span>
        <div class="process-detail">
          <div class="process-title">${() => p().name}</div>
          <div class="process-meta">
            <span>${windowLabel}</span>
            <span>${agentLabel}</span>
            ${() =>
              p().orphaned
                ? html`<span class="y-badge" title="Agent still holds a slot and its context, with no window open">orphaned</span>`
                : null}
          </div>
        </div>
      </div>
      <div class="process-actions">
        <${Show} when=${() => p().windows.length > 0}>
          <button
            class="y-btn y-btn-ghost btn-sm"
            onClick=${() => closeAppWindows(p().appId)}
            title="Close all windows of this app"
          >
            Close
          </button>
        </>
        <${Show} when=${() => p().agent !== null}>
          <button
            class="y-btn y-btn-ghost btn-sm btn-danger"
            onClick=${() => killAppAgent(p().appId)}
            title="Dispose the app agent, freeing its slot and dropping its context"
          >
            Kill
          </button>
        </>
      </div>
    </div>
  `;
}

function AppList() {
  return html`
    <${Show}
      when=${() => appProcesses().length > 0}
      fallback=${html`<div class="y-empty"><div class="y-empty-icon">&#9635;</div>No apps running</div>`}
    >
      <${For} each=${appProcesses}>${(proc: AppProcess) => html`<${AppRow} proc=${proc} />`}</>
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
    startWatching();
    registerProtocol();
  });

  return html`
    <div class="pe-app">
      <${StatsBar} />
      <div class="tab-content">
        <${Show} when=${() => activeTab() === 'agents'}><${AgentList} /></>
        <${Show} when=${() => activeTab() === 'windows'}><${WindowList} /></>
        <${Show} when=${() => activeTab() === 'apps'}><${AppList} /></>
      </div>
      <${StatusBar} />
    </div>
  `;
}

render(App, document.getElementById('app')!);
