// The gear button and the panel it opens. The account controls live here rather
// than in their own module because their styles do too (settings-popover.css) —
// the panel is the only place they are shown.

import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { signIn, signOut } from '../actions/index.js';
import { account, authBusy, hideInstalled, setHideInstalled } from '../store/index.js';
import { onBackdropClick, targetChecked } from './ui.js';

/** Whether the settings popover is open. UI-only, and private to this module. */
const [configOpen, setConfigOpen] = createSignal(false);

/** The publisher account controls (sign in / sign out). */
function accountControls() {
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
              >Signed in as <strong>${a.email}</strong>${
                owned ? html`<span class="y-text-muted"> • ${owned} owned</span>` : ''
              }</span
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
function configPanel() {
  return html`
    <div>
      ${() => {
        if (!configOpen()) return null;
        return html`
          <div class="config-backdrop" onClick=${onBackdropClick(() => setConfigOpen(false))}>
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
                    onChange=${(e: Event) => setHideInstalled(targetChecked(e))}
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

/**
 * The gear button plus the panel it toggles, kept together so `configOpen` never
 * has to leave this module — the button's `aria-expanded` and the panel's
 * visibility are two views of the same private signal.
 */
export function settingsMenu() {
  return html`
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
  `;
}
