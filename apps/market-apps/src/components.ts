// ── UI components ────────────────────────────────────────────────────────
//
// Presentation only: every Solid `html` template lives here. Components read the
// store's signals and derived views, and wire buttons straight to the actions
// layer. No network or state-shape logic in this file.

import html from '@bundled/solid-js/html';
import {
  installApp,
  publishApp,
  refreshData,
  signIn,
  signOut,
  uninstallApp,
} from './actions.js';
import {
  account,
  apiBase,
  authBusy,
  displayApps,
  hasInstalled,
  hideInstalled,
  installedApps,
  isSystem,
  lastUpdated,
  loading,
  ownsApp,
  setHideInstalled,
  statusText,
  visibleApps,
} from './store.js';
import type { DisplayApp } from './types.js';

/** Publish/Update button for an installed, non-system app — only when signed in. */
export function publishButton(app: DisplayApp) {
  if (isSystem(app.id) || !account().signedIn) return '';
  return html`
    <button
      class="y-btn y-btn-sm publish-btn"
      disabled=${() => loading()}
      onClick=${() => void publishApp(app)}
    >
      ${() => (ownsApp(app.id) ? 'Update' : 'Publish')}
    </button>
  `;
}

/** Render a single app card with Install / Publish / Uninstall actions. */
export function marketCard(app: DisplayApp) {
  const subtitle = app.notPublished
    ? 'Installed locally • not on marketplace'
    : [app.description, app.version ? `v${app.version}` : '', app.author || '']
        .filter(Boolean)
        .join(' • ');

  return html`
    <div class="y-card app-card">
      <div class="app-info">
        <div class="app-name">${app.name}</div>
        <div class="app-subtitle y-text-muted">${subtitle || app.id}</div>
      </div>
      <div class="app-actions">
        ${() => {
          const installed = app.installed || hasInstalled(app.id);
          if (installed && isSystem(app.id)) {
            return html`<span class="installed-badge" title="Built-in app" aria-label="Built-in"
              >✅</span
            >`;
          }
          if (installed) {
            return html`
              <span class="installed-badge" title="Installed" aria-label="Installed">✅</span>
              <div class="action-group">
                ${publishButton(app)}
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
        }}
      </div>
    </div>
  `;
}

/** The publisher sign-in bar between the header and the filter row. */
export function accountBar() {
  return html`
    <div class="account-bar y-surface">
      ${() => {
        const a = account();
        if (!a.configured) {
          return html`<span class="account-info y-text-muted"
            >Google sign-in is disabled on this server — GOOGLE_CLIENT_ID is set to an empty value
            in the environment.</span
          >`;
        }
        if (a.signedIn) {
          const owned = a.ownedApps.length;
          return html`
            <span class="account-info"
              >Signed in as <strong>${a.email}</strong>${owned
                ? html`<span class="y-text-muted"> • ${owned} owned</span>`
                : ''}</span
            >
            <button
              class="y-btn y-btn-sm y-btn-ghost"
              disabled=${() => authBusy()}
              onClick=${() => void signOut()}
            >
              Sign out
            </button>
          `;
        }
        return html`
          <span class="account-info y-text-muted">Not signed in — sign in to publish apps.</span>
          <button
            class="y-btn y-btn-sm y-btn-primary"
            disabled=${() => authBusy()}
            onClick=${() => void signIn()}
          >
            ${() => (authBusy() ? 'Signing in…' : 'Sign in with Google')}
          </button>
        `;
      }}
    </div>
  `;
}

/** The full application view. */
export function App() {
  return html`
    <div class="y-app">
      <!-- Header -->
      <div class="header-bar y-surface">
        <div class="header-left">
          <div class="header-title">🛒 Market Apps</div>
          <div class="header-status y-text-muted">
            ${() => statusText()}${() => (lastUpdated() ? ` • ${lastUpdated()}` : '')}
          </div>
          <div class="header-domain y-text-dim">
            ${() => (apiBase() ? `Domain: ${apiBase()}` : 'Domain: (not set)')}
          </div>
        </div>
        <button
          class="y-btn y-btn-primary refresh-btn"
          disabled=${() => loading()}
          onClick=${() => void refreshData()}
        >
          ${() => (loading() ? 'Refreshing…' : '↻ Refresh')}
        </button>
      </div>

      <!-- Publisher sign-in -->
      ${accountBar()}

      <!-- Filter bar -->
      <div class="filter-bar y-surface">
        <label class="filter-toggle">
          <input
            type="checkbox"
            checked=${() => hideInstalled()}
            onChange=${(e: Event) => setHideInstalled((e.target as HTMLInputElement).checked)}
          />
          Hide installed apps
        </label>
        <span class="filter-count y-text-muted">
          ${() => {
            const total = displayApps().length;
            const visible = visibleApps().length;
            const installed = installedApps().length;
            if (!total) return 'No apps loaded';
            return hideInstalled()
              ? `${visible} of ${total} apps • ${installed} installed`
              : `${total} apps • ${installed} installed`;
          }}
        </span>
      </div>

      <!-- App list -->
      <div class="y-scroll list-grid">
        ${() => {
          const apps = visibleApps();
          if (!apps.length) {
            const msg = displayApps().length
              ? 'All apps are already installed.'
              : 'No marketplace apps loaded.';
            return html`<div class="empty-msg y-text-muted">${msg}</div>`;
          }
          return apps.map((app) => marketCard(app));
        }}
      </div>
    </div>
  `;
}
