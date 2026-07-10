import html from '@bundled/solid-js/html';
import { createSignal } from '@bundled/solid-js';
import { errMsg } from '@bundled/yaar';
import { state, hasToken, showToast } from '../store';
import { startDeviceLogin, cancelLogin, signOut, resolveClientId } from '../auth';
import { writeClientId } from '../storage';

let clientIdEl: HTMLInputElement | null = null;

// Whether a client id is available (built-in or stored). Checked once at import;
// updated after the user saves an override. When false the sign-in card shows a
// one-time OAuth App setup prompt.
const [clientIdConfigured, setClientIdConfigured] = createSignal(true);
void resolveClientId().then((id) => setClientIdConfigured(Boolean(id)));

async function beginSignIn() {
  try {
    await startDeviceLogin();
  } catch (e) {
    // The store already holds the error for the card; toast for visibility.
    showToast(errMsg(e), 'error');
  }
}

async function saveClientId() {
  const id = clientIdEl?.value.trim() || '';
  if (!id) return;
  try {
    await writeClientId(id);
    setClientIdConfigured(true);
    showToast('Client ID saved', 'success');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

function accountCard() {
  return html`<div class="y-card settings-card">
    <div class="card-hdr">🔐 GitHub Account</div>
    ${() => {
      const status = state.auth.status;

      // Signed in ─────────────────────────────────────────────
      if (hasToken() && status !== 'pending' && status !== 'starting') {
        return html`<div class="auth-signed-in">
          <div class="auth-user">
            <span class="y-badge y-badge-success">Signed in</span>
            ${() => state.user ? html`<span class="auth-login">@${state.user.login}</span>` : null}
          </div>
          <div class="y-text-muted settings-note">
            Full access: browse private repos, create issues, comment, and close/reopen.
          </div>
          <div class="settings-actions">
            <button class="y-btn y-btn-danger" onClick=${() => void signOut()}>Sign out</button>
          </div>
        </div>`;
      }

      // Authorization in progress ──────────────────────────────
      if (status === 'starting' || status === 'pending') {
        return html`<div class="auth-pending">
          ${() => status === 'starting'
            ? html`<div class="y-text-muted"><span class="y-spinner"></span> Requesting a device code…</div>`
            : html`<div class="auth-steps">
                <div class="y-text-muted settings-note">
                  1. Open <a href=${state.auth.verificationUri} target="_blank" rel="noopener noreferrer">${state.auth.verificationUri}</a><br />
                  2. Enter this code, then authorize YAAR:
                </div>
                <div class="device-code">${() => state.auth.userCode}</div>
                <div class="y-text-muted"><span class="y-spinner"></span> Waiting for authorization…</div>
              </div>`}
          <div class="settings-actions">
            <button class="y-btn y-btn-ghost" onClick=${() => cancelLogin()}>Cancel</button>
          </div>
        </div>`;
      }

      // Signed out ─────────────────────────────────────────────
      return html`<div class="auth-signed-out">
        <div class="y-text-muted settings-note">
          Read-only public access works without signing in. Sign in with GitHub to raise the rate
          limit and enable write actions (create issue, comment, close/reopen). Uses GitHub's browser
          device flow — no token to copy.
        </div>
        ${() => state.auth.status === 'error'
          ? html`<div class="y-text-error settings-note">${state.auth.error}</div>`
          : null}
        ${() => clientIdConfigured()
          ? html`<div class="settings-actions">
              <button class="y-btn y-btn-primary" onClick=${() => void beginSignIn()}>Sign in with GitHub</button>
            </div>`
          : html`<div class="auth-clientid">
              <div class="y-text-muted settings-note">
                One-time setup: this build has no OAuth App configured. Register an
                <a href="https://github.com/settings/applications/new" target="_blank" rel="noopener noreferrer">OAuth App</a>
                (enable "Device Flow"), then paste its <strong>Client ID</strong> below (it is public, not a secret).
              </div>
              <div class="settings-row">
                <input class="y-input" placeholder="Iv1.… or Ov23…" ref=${(el: HTMLInputElement) => { clientIdEl = el; }} />
                <button class="y-btn y-btn-primary" onClick=${() => void saveClientId()}>Save</button>
              </div>
            </div>`}
      </div>`;
    }}
  </div>`;
}

export function settingsView() {
  return html`<div class="section-scroll y-scroll">
    <div class="settings-body">
      ${accountCard()}

      <div class="y-card settings-card">
        <div class="card-hdr">📊 Rate Limit</div>
        ${() => state.rateLimit
          ? html`<div class="y-text-muted">${state.rateLimit.remaining} / ${state.rateLimit.limit} requests remaining (used ${state.rateLimit.used}).</div>`
          : html`<div class="y-text-muted">No requests made yet.</div>`}
      </div>
    </div>
  </div>`;
}
