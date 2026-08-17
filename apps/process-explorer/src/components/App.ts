export {};

import { Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { activeTab, startWatching } from '../data';
import { AgentList } from './AgentList';
import { AppList } from './AppList';
import { BrowserList } from './BrowserList';
import { StatsBar } from './StatsBar';
import { StatusBar } from './StatusBar';
import { WindowList } from './WindowList';

/**
 * Root: stat cards, the selected tab's list, status bar. Each tab is its own
 * `Show` rather than a lookup, so the lists stay statically readable here — they
 * are the app.
 */
export function App() {
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
        <${Show} when=${() => activeTab() === 'browsers'}><${BrowserList} /></>
      </div>
      <${StatusBar} />
    </div>
  `;
}
