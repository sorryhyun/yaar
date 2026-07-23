// ── UI components ────────────────────────────────────────────────────────
//
// Presentation only: every Solid `html` template lives here. Components read the
// store's signals and derived views, and wire buttons straight to the actions
// layer. No network or state-shape logic in this file.

import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  cancelPublish,
  confirmPublish,
  installApp,
  publishApp,
  refreshData,
  signIn,
  signOut,
  uninstallApp,
} from './actions.js';
import { MARKET_DOMAIN } from './constants.js';
import {
  account,
  authBusy,
  confirmBusy,
  displayApps,
  githubStatus,
  hasInstalled,
  hasMarketplaceUpdate,
  hideInstalled,
  installedApps,
  isSystem,
  lastUpdated,
  loading,
  ownsApp,
  pendingPublish,
  search,
  setHideInstalled,
  setSearch,
  statusText,
  visibleApps,
} from './store.js';
import { isNewerVersion } from './parsers.js';
import type { DisplayApp } from './types.js';

/** Whether the settings/config popover is open. UI-only, so it stays local to this module. */
const [configOpen, setConfigOpen] = createSignal(false);

/** Human-readable byte size for the confirmation dialog. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Push-to-marketplace button for an installed, non-system app — only when signed in.
 *
 * This button only ever *uploads* the local copy to the marketplace. It never pulls
 * a newer version down, so it must never read as a bare "Update" — that reliably
 * gets misread as "download the newer marketplace version", which is the opposite
 * direction. First push says "Publish"; every later push says "Publish update".
 *
 * When the publisher owns the app and the local version is not newer than what is
 * already published, the button is disabled — the host would refuse the publish for
 * the same reason, so we surface it here rather than after a failed round-trip. The
 * check needs both versions: `app.version` (published, from the catalog) and
 * `app.installedVersion` (local). Absent either, we can't prove it's stale, so the
 * button stays enabled and the host remains the backstop.
 */
export function publishButton(app: DisplayApp) {
  if (isSystem(app.id) || !account().signedIn) return '';
  const published = app.version;
  const local = app.installedVersion;
  // Reactive so it tracks ownership as the account signal settles after sign-in.
  const upToDate = () =>
    ownsApp(app.id) && !!published && !!local && !isNewerVersion(local, published);
  return html`
    <button
      class="y-btn y-btn-sm publish-btn"
      disabled=${() => loading() || upToDate()}
      title=${() =>
        upToDate()
          ? `v${published} is already published — bump "version" in app.json to publish an update`
          : ownsApp(app.id)
            ? `Publish your local version of ${app.name} to the marketplace as a new version`
            : `Publish ${app.name} to the marketplace for the first time`}
      onClick=${() => void publishApp(app)}
    >
      ${() =>
        upToDate() ? `v${published} published` : ownsApp(app.id) ? 'Publish update' : 'Publish'}
    </button>
  `;
}

/** Render a single app card with Install / Publish / Uninstall actions. */
export function marketCard(app: DisplayApp) {
  const updateAvailable = () => hasMarketplaceUpdate(app);
  const subtitle = app.notPublished
    ? 'Installed locally • not on marketplace'
    : [app.description, app.version ? `v${app.version}` : '', app.author || '']
        .filter(Boolean)
        .join(' • ');

  return html`
    <div class="y-card app-card">
      <div class="app-info">
        <div class="app-name">
          ${app.name}${() =>
            ownsApp(app.id)
              ? html`<span
                  class="publisher-badge"
                  title="You published this app"
                  aria-label="You published this app"
                  >✏️</span
                >`
              : ''}
        </div>
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
                ${() =>
                  updateAvailable()
                    ? html`<button
                        class="y-btn y-btn-sm y-btn-primary"
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
        }}
      </div>
    </div>
  `;
}

/**
 * A warning strip above the header, shown *only* while GitHub is degraded.
 *
 * Publishing writes through GitHub's API, so an outage there fails a publish with
 * an opaque 5xx that reads like a bug in your app. Renders nothing at all when
 * GitHub is healthy — a permanently-visible green light would just train the eye
 * to skip past it on the one day it turns red.
 */
export function githubBanner() {
  return html`
    <div>
      ${() => {
        const s = githubStatus();
        if (!s.degraded) return null;
        // One interpolation, not three: `solid-js/html` drops the literal
        // whitespace between two adjacent `${}` expressions, which ran the
        // component name into the severity ("API Requestspartial outage").
        const headline = `GitHub ${s.components.join(' and ')}: ${s.level.replace(/_/g, ' ')}`;
        return html`
          <div class="github-banner" role="status">
            <span class="github-banner-icon">⚠</span>
            <div class="github-banner-body">
              <div>
                <strong>${headline}</strong>
                <span class="y-text-muted"> — publishing may fail until it recovers.</span>
              </div>
              ${s.incident
                ? html`<div class="github-banner-detail y-text-muted y-clamp-2">${s.incident}</div>`
                : ''}
            </div>
            <a
              class="y-btn y-btn-sm y-btn-ghost"
              href="https://www.githubstatus.com"
              target="_blank"
              rel="noreferrer noopener"
              >Details</a
            >
          </div>
        `;
      }}
    </div>
  `;
}

/** The publisher account controls (sign in / sign out), reused inside the config panel. */
export function accountControls() {
  return html`
    <div class="account-controls">
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

/**
 * Settings/config popover. Consolidates the account controls and the
 * "Hide installed apps" filter that used to sit inline in the header, so the
 * primary view stays focused on the search box and the app list.
 *
 * Stable outer node + reactive inner content (the `githubBanner` idiom): the
 * panel shows/hides as `configOpen` flips without the parent re-rendering. A
 * full-screen backdrop closes it on an outside click.
 */
export function configPanel() {
  return html`
    <div>
      ${() => {
        if (!configOpen()) return null;
        return html`
          <div
            class="config-backdrop"
            onClick=${(e: Event) => {
              if (e.target === e.currentTarget) setConfigOpen(false);
            }}
          >
            <div
              class="config-panel y-surface"
              role="dialog"
              aria-modal="true"
              aria-label="Settings"
            >
              <div class="config-panel-head">
                <span class="config-panel-title">Settings</span>
                <button
                  class="y-btn y-btn-sm y-btn-ghost"
                  title="Close"
                  aria-label="Close settings"
                  onClick=${() => setConfigOpen(false)}
                >
                  ✕
                </button>
              </div>

              <div class="config-section">
                <div class="config-section-label y-text-muted">Account</div>
                ${accountControls()}
              </div>

              <div class="config-section">
                <div class="config-section-label y-text-muted">Filters</div>
                <label class="filter-toggle">
                  <input
                    type="checkbox"
                    checked=${() => hideInstalled()}
                    onChange=${(e: Event) =>
                      setHideInstalled((e.target as HTMLInputElement).checked)}
                  />
                  Hide installed apps
                </label>
              </div>
            </div>
          </div>
        `;
      }}
    </div>
  `;
}

/** The full application view. */
/**
 * The publish confirmation dialog. Stable outer node + reactive inner content (the
 * `githubBanner` idiom), so it shows/hides as `pendingPublish` flips without the
 * parent re-rendering. Shows the frozen digest + size the user is approving, and on
 * source drift, the changed-file list behind a "Publish anyway" press.
 */
export function publishModal() {
  return html`
    <div>
      ${() => {
        const pending = pendingPublish();
        if (!pending) return null;
        const { app, summary } = pending;
        const drifted = !!pending.drift;
        const files = pending.drift?.changedFiles ?? [];
        return html`
          <div
            class="publish-backdrop"
            onClick=${(e: Event) => {
              // Click the dim area (not the card) to cancel.
              if (e.target === e.currentTarget && !confirmBusy()) void cancelPublish();
            }}
          >
            <div class="publish-modal y-surface" role="dialog" aria-modal="true">
              <div class="publish-modal-title">Publish ${app.name}</div>
              <dl class="publish-meta">
                <div class="publish-meta-row">
                  <dt class="y-text-muted">Version</dt>
                  <dd>${summary.version ?? '(none)'}</dd>
                </div>
                <div class="publish-meta-row">
                  <dt class="y-text-muted">Artifact</dt>
                  <dd class="publish-digest">sha256:${summary.artifactSha256.slice(0, 12)}…</dd>
                </div>
                <div class="publish-meta-row">
                  <dt class="y-text-muted">Size</dt>
                  <dd>${formatBytes(summary.byteLength)}</dd>
                </div>
              </dl>
              ${drifted
                ? html`<div class="publish-drift" role="alert">
                    <div class="publish-drift-head">⚠ Source changed since prepare</div>
                    <div class="y-text-muted">
                      "Publish anyway" uploads the frozen snapshot you prepared — not these newer
                      edits. Cancel and publish again to include them.
                    </div>
                    <ul class="publish-drift-files">
                      ${(files.length ? files : ['(changed-file list unavailable)']).map(
                        (f) => html`<li class="publish-digest">${f}</li>`,
                      )}
                    </ul>
                  </div>`
                : ''}
              <div class="publish-actions">
                <button
                  class="y-btn y-btn-sm"
                  disabled=${() => confirmBusy()}
                  onClick=${() => void cancelPublish()}
                >
                  Cancel
                </button>
                <button
                  class="y-btn y-btn-sm y-btn-primary"
                  disabled=${() => confirmBusy()}
                  onClick=${() => void confirmPublish(drifted)}
                >
                  ${() => (confirmBusy() ? 'Publishing…' : drifted ? 'Publish anyway' : 'Publish')}
                </button>
              </div>
            </div>
          </div>
        `;
      }}
    </div>
  `;
}

export function App() {
  return html`
    <div class="y-app">
      <!-- GitHub outage warning (renders nothing while healthy) -->
      ${githubBanner()}

      <!-- Publish confirmation dialog (renders nothing until a publish is prepared) -->
      ${publishModal()}

      <!-- Header -->
      <div class="header-bar y-surface">
        <div class="header-left">
          <div class="header-title">🛒 Market Apps</div>
          <div class="header-status y-text-muted">
            ${() => statusText()}${() => (lastUpdated() ? ` • ${lastUpdated()}` : '')}
          </div>
          <div class="header-domain y-text-dim">Domain: ${MARKET_DOMAIN}</div>
        </div>
        <div class="header-actions">
          <div class="config-wrap">
            <button
              class="y-btn y-btn-ghost config-btn"
              title="Settings"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded=${() => configOpen()}
              onClick=${() => setConfigOpen(!configOpen())}
            >
              ⚙️
            </button>
            ${configPanel()}
          </div>
          <button
            class="y-btn y-btn-primary refresh-btn"
            disabled=${() => loading()}
            onClick=${() => void refreshData()}
          >
            ${() => (loading() ? 'Refreshing…' : '↻ Refresh')}
          </button>
        </div>
      </div>

      <!-- Search bar (primary filter) -->
      <div class="search-bar y-surface">
        <input
          class="y-input search-input"
          type="search"
          placeholder="Search apps by name or description…"
          aria-label="Search apps"
          value=${() => search()}
          onInput=${(e: Event) => setSearch((e.target as HTMLInputElement).value)}
        />
        <span class="filter-count y-text-muted">
          ${() => {
            const total = displayApps().length;
            const visible = visibleApps().length;
            const installed = installedApps().length;
            if (!total) return 'No apps loaded';
            const filtered = hideInstalled() || !!search().trim();
            return filtered
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
            const msg = !displayApps().length
              ? 'No marketplace apps loaded.'
              : search().trim()
                ? 'No apps match your search.'
                : 'All apps are already installed.';
            return html`<div class="empty-msg y-text-muted">${msg}</div>`;
          }
          return apps.map((app) => marketCard(app));
        }}
      </div>
    </div>
  `;
}
