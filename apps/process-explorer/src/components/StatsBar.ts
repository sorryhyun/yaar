export {};

import { For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeTab, agentStats, appProcesses, browsers, selectTab, windows } from '../data';
import type { TabId } from '../types';

interface StatCard {
  /** The tab this card selects. Doubles as the card's identity in the list. */
  id: TabId;
  label: string;
  /** The headline count. */
  value: () => number;
  /** The qualifier beneath it — the subset worth noticing, or a "none" line. */
  sub: () => string;
}

/**
 * The cards, as data. They were near-identical markup blocks; the only real
 * differences are the two accessors, so a card is four fields and a new tab is
 * one entry rather than one more copy of the block.
 */
const CARDS: StatCard[] = [
  {
    id: 'agents',
    label: 'Agents',
    value: () => agentStats()?.totalAgents ?? 0,
    sub: () => `${agentStats()?.busyAgents ?? 0} busy`,
  },
  {
    id: 'windows',
    label: 'Windows',
    value: () => windows().length,
    sub: () => {
      const locked = windows().filter((w) => w.locked).length;
      return locked > 0 ? `${locked} locked` : 'none locked';
    },
  },
  {
    id: 'apps',
    label: 'Apps',
    value: () => appProcesses().length,
    sub: () => {
      const orphaned = appProcesses().filter((p) => p.orphaned).length;
      return orphaned > 0 ? `${orphaned} orphaned` : 'none orphaned';
    },
  },
  {
    id: 'browsers',
    label: 'Browsers',
    value: () => browsers().length,
    // Suspended is the count worth surfacing: those are ids that still name a
    // page with nothing connected to it, and the only ones with a Revive button.
    sub: () => {
      const suspended = browsers().filter((b) => b.state !== 'live').length;
      return suspended > 0 ? `${suspended} suspended` : 'all live';
    },
  },
];

/** Top bar: one clickable card per tab, showing that tab's headline count. */
export function StatsBar() {
  return html`
    <div class="stats-bar">
      <${For} each=${() => CARDS}>${(card: StatCard) => html`
        <div
          class=${() => `stat-card y-card${activeTab() === card.id ? ' active' : ''}`}
          onClick=${() => selectTab(card.id)}
        >
          <div class="stat-value">${card.value}</div>
          <div class="stat-label">${card.label}</div>
          <div class="stat-sub">${card.sub}</div>
        </div>
      `}</>
    </div>
  `;
}
