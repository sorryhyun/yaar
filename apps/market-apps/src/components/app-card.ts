// One card in the list: identity badges on the left, the action buttons on the right.

import html from '@bundled/solid-js/html';
import { installApp, publishApp, uninstallApp } from '../actions/index.js';
import {
  account,
  hasInstalled,
  hasMarketplaceUpdate,
  installedVersionOrder,
  isOfficialAuthor,
  isSystem,
  loading,
  ownsApp,
} from '../store/index.js';
import type { DisplayApp } from '../types.js';
import { badge } from './ui.js';

/**
 * Push-to-marketplace button for an installed, non-system app — only when signed in.
 *
 * This button only ever *uploads* the local copy to the marketplace. It never pulls
 * a newer version down, so it must never read as a bare "Update" — that reliably
 * gets misread as "download the newer marketplace version", which is the opposite
 * direction. First push says "Publish"; every later push says "Publish update".
 *
 * When the publisher owns the app and the local version is not *newer* than what is
 * already published, the button is disabled — the host would refuse the publish for
 * the same reason, so we surface it here rather than after a failed round-trip. Both
 * `older` and `same` block: pushing a copy the marketplace is already ahead of would
 * publish a downgrade, and it must never read as "Publish update".
 *
 * `unknown` (either version absent or not numeric dot-parts) stays enabled on
 * purpose. We cannot prove the copy is stale, and refusing would strand every app
 * whose version is a codename; the host remains the backstop there. The tooltip says
 * so rather than implying a comparison we did not make.
 *
 * The order is read live from the store, not from `app.installedVersion` — the
 * "Install update" branch above reads the store too, and the two deciding from
 * different snapshots is what let them disagree about the same app.
 */
function publishButton(app: DisplayApp) {
  if (isSystem(app.id) || !account().signedIn) return '';
  const published = app.version;
  // Reactive so it tracks ownership as the account signal settles after sign-in.
  const owns = () => ownsApp(app.id);
  const order = () => installedVersionOrder(app);
  const blocked = () => owns() && (order() === 'older' || order() === 'same');
  return html`
    <button
      class="y-btn y-btn-sm publish-btn"
      disabled=${() => loading() || blocked()}
      title=${() => {
        if (blocked()) {
          return order() === 'older'
            ? `The marketplace already serves v${published}, which is newer than the copy on this machine — install it before publishing over it`
            : `v${published} is already published — bump "version" in app.json to publish an update`;
        }
        if (!owns()) return `Publish ${app.name} to the marketplace for the first time`;
        return order() === 'unknown' && published
          ? `Publish your local version of ${app.name}. Its version can't be compared with the published v${published}, so the marketplace decides.`
          : `Publish your local version of ${app.name} to the marketplace as a new version`;
      }}
      onClick=${() => void publishApp(app)}
    >
      ${() => (blocked() ? `v${published} published` : owns() ? 'Publish update' : 'Publish')}
    </button>
  `;
}

/** The right-hand action cluster: install, or the installed badge + update/publish/uninstall. */
function cardActions(app: DisplayApp) {
  const updateAvailable = () => hasMarketplaceUpdate(app);
  const installed = app.installed || hasInstalled(app.id);

  if (installed && isSystem(app.id)) {
    return badge('installed-badge', '✅', 'Built-in', 'Built-in app');
  }

  if (installed) {
    return html`
      ${badge('installed-badge', '✅', 'Installed')}
      <div class="action-group">
        ${() =>
          updateAvailable()
            ? html`<button
                class="y-btn y-btn-sm y-btn-warning install-update-btn"
                title=${`Replace the installed copy with v${app.version} from the marketplace`}
                disabled=${() => loading()}
                onClick=${() => void installApp(app)}
              >
                Install update
              </button>`
            : publishButton(app)}
        <button
          class="y-btn y-btn-sm y-btn-danger uninstall-btn"
          title="Uninstall"
          disabled=${() => loading()}
          onClick=${() => void uninstallApp(app)}
        >
          Uninstall
        </button>
      </div>
    `;
  }

  return html`
    <button
      class="y-btn y-btn-sm y-btn-primary"
      disabled=${() => loading()}
      onClick=${() => void installApp(app)}
    >
      Install
    </button>
  `;
}

/** The subtitle line: either the "not on marketplace" note, or description • version • author. */
function cardSubtitle(app: DisplayApp): string {
  if (app.notPublished) return 'Installed locally • not on marketplace';
  return [app.description, app.version ? `v${app.version}` : '', app.author || '']
    .filter(Boolean)
    .join(' • ');
}

export function marketCard(app: DisplayApp) {
  const subtitle = cardSubtitle(app);

  return html`
    <div class="y-card app-card">
      <div class="app-info">
        <div class="app-name">
          ${app.name}${() =>
            isOfficialAuthor(app.author)
              ? badge('official-badge', 'Official', 'Official YAAR app')
              : ''}${() =>
            ownsApp(app.id) ? badge('publisher-badge', '✏️', 'You published this app') : ''}
        </div>
        <div class="app-subtitle y-text-muted">${subtitle || app.id}</div>
      </div>
      <div class="app-actions">${() => cardActions(app)}</div>
    </div>
  `;
}