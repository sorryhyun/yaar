import html from '@bundled/solid-js/html';
import { refreshData } from '../actions/index.js';
import { MARKET_DOMAIN } from '../constants.js';
import { lastUpdated, loading, statusText } from '../store/index.js';
import { settingsMenu } from './settings-popover.js';

/** Title, status line and the domain this app is compiled against, plus the two controls. */
export function headerBar() {
  return html`
    <div class="header-bar y-surface">
      <div class="header-left">
        <div class="header-title">🛒 Market Apps</div>
        <div class="header-status y-text-muted">
          ${() => statusText()}${() => (lastUpdated() ? ` • ${lastUpdated()}` : '')}
        </div>
        <div class="header-domain y-text-dim">Domain: ${MARKET_DOMAIN}</div>
      </div>
      <div class="header-actions">
        ${settingsMenu()}
        <button
          class="y-btn y-btn-primary refresh-btn"
          disabled=${() => loading()}
          onClick=${() => void refreshData()}
        >
          ${() => (loading() ? 'Refreshing…' : '↻ Refresh')}
        </button>
      </div>
    </div>
  `;
}
