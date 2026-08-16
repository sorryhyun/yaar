import html from '@bundled/solid-js/html';
import { displayApps, search, visibleApps } from '../store/index.js';
import { marketCard } from './app-card.js';

/**
 * Why the list is empty, in the user's terms: nothing loaded at all, nothing
 * matching the query, or everything already installed (the Hide Installed filter).
 */
function emptyMessage(): string {
  if (!displayApps().length) return 'No marketplace apps loaded.';
  return search().trim() ? 'No apps match your search.' : 'All apps are already installed.';
}

/** The scrolling card grid — the app's main surface. */
export function appGrid() {
  return html`
    <div class="y-scroll list-grid">
      ${() => {
        const apps = visibleApps();
        if (!apps.length) {
          return html`<div class="empty-msg y-text-muted">${emptyMessage()}</div>`;
        }
        return apps.map((app) => marketCard(app));
      }}
    </div>
  `;
}
