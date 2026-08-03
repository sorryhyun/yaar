export {};

import { onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import type { AgentEntry, AgentTurnState, AgentUsage, WindowInfo, AppProcess } from './types';
import {
  agentStats,
  agentList,
  agentActivity,
  now,
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
import './styles.css';

// ── Helpers ──────────────────────────────────────────────────

function typeBadge(type: AgentEntry['type']) {
  const colors: Record<string, string> = {
    monitor: 'var(--yaar-accent)',
    app: 'var(--yaar-success)',
    // An app's own persona — same family as its app agent, dimmer because a room
    // of four should read as one app's cast rather than four peers of it.
    persona: 'color-mix(in srgb, var(--yaar-success) 55%, var(--yaar-text-muted))',
    ephemeral: 'var(--yaar-text-muted)',
    session: '#f5a623',
  };
  return colors[type] ?? 'var(--yaar-text-muted)';
}

/**
 * Label + colour for a turn state. `done` is deliberately muted and `interrupted`
 * is not: a turn the user cut short is worth noticing, one that finished isn't.
 */
const TURN_STATE_STYLE: Record<AgentTurnState, { label: string; color: string }> = {
  responding: { label: 'responding', color: 'var(--yaar-accent)' },
  'using-tool': { label: 'using tool', color: 'var(--yaar-accent)' },
  done: { label: 'done', color: 'var(--yaar-text-muted)' },
  error: { label: 'error', color: 'var(--yaar-error)' },
};

/** Elapsed time since a frame arrived, as a glanceable "how stale is this row". */
function formatAge(ts: number, at: number) {
  const secs = Math.max(0, Math.round((at - ts) / 1000));
  if (secs < 1) return 'now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function formatTime(date: Date | null) {
  if (!date) return '--';
  return date.toLocaleTimeString();
}

/** Compact token count — 812, 12.4k, 3.1M. Exact below 1k, where the digits still read. */
function formatTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Input the agent actually *spent* — fresh tokens plus cache writes, cache
 * **reads excluded**. The one place those fields are summed; see {@link AgentUsage}.
 *
 * Cache reads are left out because they are the same context re-sent every turn:
 * counting them makes a long-running agent's "in" figure climb roughly linearly
 * with turn count while nothing new is being read, which reads as a leak. Cache
 * writes stay in — they are new content passing through the model for the first
 * time, and are billed as such.
 *
 * `inputTokens` alone would be too low the other way (~10 for an 18k-context
 * turn), since providers report it as the remainder that was neither read from
 * nor written to the cache. Fresh + writes is the figure that grows only when
 * the agent takes in something it has not seen before.
 */
function inputRead(usage: AgentUsage) {
  return usage.inputTokens + (usage.cacheWriteTokens ?? 0);
}

/**
 * Token line: the total, with the input/output split behind it.
 *
 * Total first because it is the one number that answers "how much did this cost";
 * the split is what you read next when the answer is "a lot" and you want to know
 * whether it was context or generation. Empty string when nothing has been spent,
 * so a fresh agent shows no column rather than a row of zeroes.
 */
function formatUsage(usage: AgentUsage | undefined) {
  if (!usage) return '';
  const input = inputRead(usage);
  const total = input + usage.outputTokens;
  if (total === 0) return '';
  return `${formatTokens(total)} tok · ${formatTokens(input)} in · ${formatTokens(usage.outputTokens)} out`;
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
    if (a().busy) return 'y-dot y-dot-warn';
    if (a().type === 'ephemeral') return 'y-dot y-dot-warn';
    return 'y-dot y-dot-ok';
  };

  // Live activity, folded from the agent's stream: an explicit turn state, the
  // tool line, a tail of text, and how long since the last frame.
  const act = () => agentActivity[a().id];
  const toolText = () => {
    const t = act()?.tool;
    return t ? `${t.name} · ${t.status}` : '';
  };
  const bodyText = () => act()?.text ?? '';
  const stateStyle = () => {
    const state = act()?.state;
    return state ? TURN_STATE_STYLE[state] : null;
  };
  const stateLabel = () => {
    const activity = act();
    if (!activity) return '';
    // An interrupted turn reads as its own outcome, not a plain `done`.
    if (activity.state === 'done' && activity.endStatus === 'interrupted') return 'interrupted';
    return TURN_STATE_STYLE[activity.state].label;
  };
  const ageText = () => {
    const at = act()?.updatedAt;
    return at ? formatAge(at, now()) : '';
  };
  const errorText = () => act()?.error ?? '';

  // The stream's figure when we have one, the roster's otherwise. Both are the
  // agent's lifetime total; the stream just gets there first, between polls.
  const usageText = () => formatUsage(act()?.usage ?? a().usage);

  return html`
    <div class="process-row">
      <div class="process-info">
        <span class=${dotClass}></span>
        <div class="process-detail">
          <div class="process-title">${() => a().label}</div>
          <div class="process-meta">
            <span style=${() => `color: ${typeBadge(a().type)}`}>${() => a().type}</span>
            <span>${() => (a().busy ? 'busy' : 'idle')}</span>
            <${Show} when=${usageText}>
              <span class="meta-tokens" title="Input + output tokens. Cache reads excluded; cache writes count as input."
                >${usageText}</span
              >
            </>
          </div>
          <${Show} when=${() => act() !== undefined}>
            <div class="process-activity">
              <div class="activity-state">
                <span class="activity-badge" style=${() => `color: ${stateStyle()?.color ?? ''}`}
                  >${stateLabel}</span
                >
                <span class="activity-age">${ageText}</span>
              </div>
              <${Show} when=${toolText}>
                <span class="activity-tool y-truncate">${toolText}</span>
              </>
              <${Show} when=${errorText}>
                <span class="activity-error y-truncate">${errorText}</span>
              </>
              <${Show} when=${bodyText}>
                <span class="activity-text y-truncate">${bodyText}</span>
              </>
            </div>
          </>
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
    if (p().agent?.busy) return 'y-dot y-dot-warn';
    if (p().orphaned) return 'y-dot y-dot-warn';
    return 'y-dot y-dot-ok';
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
  // Session-wide, disposed agents included — so it can exceed the sum of the rows
  // above, and that gap is the point: it's what the ephemeral agents spent.
  const sessionUsage = () => formatUsage(agentStats()?.usage);
  return html`
    <div class="status-bar">
      <span>Last refresh: ${() => formatTime(lastRefresh())}</span>
      <${Show} when=${sessionUsage}>
        <span class="meta-tokens" title="Session total, including agents already disposed. Cache reads excluded; cache writes count as input."
          >${sessionUsage}</span
        >
      </>
      <button class="y-btn y-btn-ghost btn-sm" onClick=${() => refreshAll()}>Refresh</button>
    </div>
  `;
}

function App() {
  onMount(() => {
    startWatching();
  });

  return html`
    <div class="pe-app">
      <${StatsBar} />
      <div class="tab-content y-scroll">
        <${Show} when=${() => activeTab() === 'agents'}><${AgentList} /></>
        <${Show} when=${() => activeTab() === 'windows'}><${WindowList} /></>
        <${Show} when=${() => activeTab() === 'apps'}><${AppList} /></>
      </div>
      <${StatusBar} />
    </div>
  `;
}

export default defineApp({
  id: 'process-explorer',
  name: 'Process Explorer',

  state: {
    stats: {
      description: 'Overview: agent, window, and running-app counts',
      get: () => ({
        agents: agentStats(),
        windowCount: windows().length,
        appCount: appProcesses().length,
        orphanedAppCount: appProcesses().filter((p) => p.orphaned).length,
      }),
    },
    agents: {
      description: 'List of all agents with type and status',
      get: () => agentList(),
    },
    windows: {
      description: 'List of all open windows',
      get: () => windows(),
    },
    apps: {
      description:
        'Running apps — each with its open windows and its app agent. An app is "orphaned" ' +
        'when its agent is still alive with no window open, holding a slot and its context.',
      get: () => appProcesses(),
    },
  },

  commands: {
    refresh: {
      description: 'Force refresh all data',
      params: { type: 'object', properties: {} },
      run: async () => {
        await refreshAll();
        return { ok: true };
      },
    },
    interruptAgent: {
      description: 'Interrupt a running agent by ID',
      params: {
        type: 'object',
        properties: { agentId: { type: 'string' } },
        required: ['agentId'],
      },
      run: async (p) => {
        await interruptAgent(p.agentId);
        return { ok: true };
      },
    },
    closeWindow: {
      description: 'Close a window by ID',
      params: {
        type: 'object',
        properties: { windowId: { type: 'string' } },
        required: ['windowId'],
      },
      run: async (p) => {
        await closeWindow(p.windowId);
        return { ok: true };
      },
    },
    killAppAgent: {
      description:
        'Dispose an app agent by appId, freeing its slot and dropping its context. The app stays ' +
        'installed and its windows stay open; the next interaction spawns a fresh agent.',
      params: {
        type: 'object',
        properties: { appId: { type: 'string' } },
        required: ['appId'],
      },
      run: async (p) => {
        await killAppAgent(p.appId);
        return { ok: true };
      },
    },
    closeAppWindows: {
      description: 'Close every open window belonging to an app. Leaves its agent alone.',
      params: {
        type: 'object',
        properties: { appId: { type: 'string' } },
        required: ['appId'],
      },
      run: async (p) => {
        await closeAppWindows(p.appId);
        return { ok: true };
      },
    },
  },

  view: App,
});
