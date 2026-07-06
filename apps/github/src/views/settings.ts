import html from '@bundled/solid-js/html';
import { errMsg } from '@bundled/yaar';
import { state, hasToken, showToast } from '../store';
import { setTokenAction, setRepoAction } from '../actions';

let tokenEl: HTMLInputElement | null = null;
let ownerEl: HTMLInputElement | null = null;
let nameEl: HTMLInputElement | null = null;

async function saveToken() {
  try {
    await setTokenAction(tokenEl?.value || '');
    if (tokenEl) tokenEl.value = '';
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

async function clearToken() {
  try {
    await setTokenAction('');
    if (tokenEl) tokenEl.value = '';
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

async function saveRepo() {
  try {
    await setRepoAction(ownerEl?.value || '', nameEl?.value || '');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

export function settingsView() {
  return html`<div class="section-scroll y-scroll">
    <div class="settings-body">
      <div class="y-card settings-card">
        <div class="card-hdr">📁 Active Repository</div>
        <div class="settings-row">
          <input class="y-input" placeholder="owner" value=${() => state.repo.owner} ref=${(el: HTMLInputElement) => { ownerEl = el; }} />
          <span class="slash">/</span>
          <input class="y-input" placeholder="repository" value=${() => state.repo.name} ref=${(el: HTMLInputElement) => { nameEl = el; }} />
        </div>
        <button class="y-btn y-btn-primary" onClick=${() => void saveRepo()}>Switch repository</button>
      </div>

      <div class="y-card settings-card">
        <div class="card-hdr">🔑 Personal Access Token</div>
        <div class="y-text-muted settings-note">
          Optional. Read-only public access works without a token. Add a fine-grained or classic PAT to raise the
          rate limit and enable write actions (create issue, comment, close/reopen). Stored locally at
          <code>github/token</code>.
        </div>
        <div class="settings-status">
          Status: ${() => hasToken()
            ? html`<span class="y-badge y-badge-success">Token set</span>`
            : html`<span class="y-badge y-badge-warning">No token — read-only</span>`}
        </div>
        <input class="y-input" type="password" placeholder="ghp_… or github_pat_…" ref=${(el: HTMLInputElement) => { tokenEl = el; }} />
        <div class="settings-actions">
          <button class="y-btn y-btn-primary" onClick=${() => void saveToken()}>Save token</button>
          <button class="y-btn y-btn-danger" disabled=${() => !hasToken()} onClick=${() => void clearToken()}>Clear token</button>
        </div>
      </div>

      <div class="y-card settings-card">
        <div class="card-hdr">📊 Rate Limit</div>
        ${() => state.rateLimit
          ? html`<div class="y-text-muted">${state.rateLimit.remaining} / ${state.rateLimit.limit} requests remaining (used ${state.rateLimit.used}).</div>`
          : html`<div class="y-text-muted">No requests made yet.</div>`}
      </div>
    </div>
  </div>`;
}
