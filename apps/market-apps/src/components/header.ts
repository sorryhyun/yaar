import html from '@bundled/solid-js/html';
import { refreshData, updateAllApps } from '../actions/index.js';
import { MARKET_DOMAIN } from '../constants.js';
import { lastUpdated, loading, outdatedApps, statusText, updateRun } from '../store/index.js';
import { settingsMenu } from './settings-popover.js';

/**
 * Bulk update control, shown only when there is something to update or a run is in
 * flight. Hidden rather than permanently disabled: a greyed button sitting next to
 * Refresh reads as broken, where its absence reads as "nothing to do".
 *
 * Presence is decided here and the label and disabled state are thunks, so a run's
 * progress re-renders the text without replacing the button the user just clicked.
 */
function updateAllButton() {
  const count = outdatedApps().length;
  if (!updateRun().active && count === 0) return '';

  const progress = () => {
    const run = updateRun();
    // `completed` counts apps finished, so the one in flight is the next number up.
    return `Updating ${Math.min(run.completed + 1, run.total)}/${run.total}…`;
  };
  return html`
    <button
      class="y-btn y-btn-warning update-all-btn"
      disabled=${() => loading() || updateRun().active}
      title=${() =>
        updateRun().active
          ? `Updating ${updateRun().current ?? ''}`
          : `Install the marketplace version of ${outdatedApps().length} outdated app(s)`}
      onClick=${() => void updateAllApps({ confirm: true })}
    >
      ${() => (updateRun().active ? progress() : `⬆ Update All (${outdatedApps().length})`)}
    </button>
  `;
}

/** Title, status line and the domain this app is compiled against, plus the controls. */
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
        ${settingsMenu()} ${() => updateAllButton()}
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
