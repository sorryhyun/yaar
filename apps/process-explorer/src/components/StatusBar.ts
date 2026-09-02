export {};

import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { agentStats, lastRefresh, refreshAll } from '../data';
import { formatTime, formatUsage } from '../format';

/** Bottom bar: when the panel last agreed with the server, and the session total. */
export function StatusBar() {
  // Session-wide, disposed agents included — so it can exceed the sum of the rows
  // above, and that gap is the point: it's what the ephemeral agents spent.
  const sessionUsage = () => formatUsage(agentStats()?.usage);

  return html`
    <div class="y-statusbar y-statusbar-dense">
      <span>Last refresh: ${() => formatTime(lastRefresh())}</span>
      <${Show} when=${sessionUsage}>
        <span class="meta-tokens" title="Session total, including agents already disposed. Cache reads excluded; cache writes count as input."
          >${sessionUsage}</span
        >
      </>
      <button class="y-btn y-btn-ghost y-btn-sm" onClick=${() => refreshAll()}>Refresh</button>
    </div>
  `;
}
