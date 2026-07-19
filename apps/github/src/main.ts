import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { errMsg } from '@bundled/yaar';
import type { Section } from './types';
import { state, setState, hasToken, showToast } from './store';
import { bootstrapStorage } from './storage';
import {
  selectSection, loadSection, refreshAll, toggleRepoPicker, closeRepoPicker,
  loadAccountRepos, selectAccountRepo, setRepoAction,
} from './actions';
import { refreshUser } from './auth';
import { registerAppProtocol } from './protocol';
import { resetCountdown } from './utils';
import { overviewView } from './views/overview';
import { issuesView } from './views/issues';
import { pullsView } from './views/pulls';
import { releasesView } from './views/releases';
import { codeView } from './views/code';
import { settingsView } from './views/settings';
import './styles.css';

const NAV: Array<{ id: Section; icon: string; label: string }> = [
  { id: 'overview', icon: '📑', label: 'Overview' },
  { id: 'issues', icon: '⚠️', label: 'Issues' },
  { id: 'pulls', icon: '🔀', label: 'Pull Requests' },
  { id: 'releases', icon: '🏷️', label: 'Releases' },
  { id: 'code', icon: '📁', label: 'Code' },
];

let pickerOwnerEl: HTMLInputElement | null = null;
let pickerNameEl: HTMLInputElement | null = null;

async function switchTypedRepo(): Promise<void> {
  try {
    await setRepoAction(pickerOwnerEl?.value || '', pickerNameEl?.value || '');
    closeRepoPicker();
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

function repoPicker() {
  return () => state.repoPickerOpen ? html`
    <div class="repo-picker-scrim" onClick=${closeRepoPicker}></div>
    <section class="repo-picker" role="dialog" aria-label="Choose repository">
      <div class="repo-picker-head">
        <div>
          <div class="repo-picker-title">Repositories</div>
          <div class="repo-picker-account">${() => state.user ? '@' + state.user.login : 'GitHub account'}</div>
        </div>
        <button class="y-btn y-btn-ghost y-btn-sm repo-picker-close" aria-label="Close repository picker" onClick=${closeRepoPicker}>×</button>
      </div>
      <div class="repo-picker-manual" aria-label="Open repository by owner and name">
        <div class="repo-picker-manual-label">Open any repository</div>
        <div class="repo-picker-manual-row">
          <input class="y-input" aria-label="Repository owner" placeholder="owner" value=${() => state.repo.owner} ref=${(el: HTMLInputElement) => { pickerOwnerEl = el; }} />
          <span class="slash">/</span>
          <input class="y-input" aria-label="Repository name" placeholder="repository" value=${() => state.repo.name} ref=${(el: HTMLInputElement) => { pickerNameEl = el; }} />
          <button class="y-btn y-btn-primary y-btn-sm" onClick=${() => void switchTypedRepo()}>Open</button>
        </div>
      </div>
      ${() => !hasToken() ? html`
        <div class="repo-picker-message">
          <span>Sign in to browse repositories available to your GitHub account.</span>
          <button class="y-btn y-btn-primary y-btn-sm" onClick=${() => { closeRepoPicker(); selectSection('settings'); }}>Open Settings</button>
        </div>
      ` : html`
        <div class="repo-picker-tools">
          <input
            class="y-input repo-search"
            type="search"
            placeholder="Find a repository…"
            aria-label="Find a repository"
            value=${() => state.repoSearch}
            onInput=${(e: InputEvent) => setState('repoSearch', (e.currentTarget as HTMLInputElement).value)}
          />
          <button class="y-btn y-btn-ghost y-btn-sm" title="Reload repositories" disabled=${() => state.accountReposLoading} onClick=${() => void loadAccountRepos(true)}>↻</button>
        </div>
        <div class="repo-picker-list">
          ${() => {
            if (state.accountReposLoading && state.accountRepos.length === 0) {
              return html`<div class="repo-picker-message">Loading repositories…</div>`;
            }
            if (state.repoPickerError) {
              return html`<div class="repo-picker-message y-text-error">${state.repoPickerError}</div>`;
            }
            const query = state.repoSearch.trim().toLowerCase();
            const repos = query
              ? state.accountRepos.filter((repo) =>
                  repo.full_name.toLowerCase().includes(query) ||
                  (repo.description || '').toLowerCase().includes(query))
              : state.accountRepos;
            if (repos.length === 0) {
              return html`<div class="repo-picker-message">${query ? 'No matching repositories.' : 'No repositories found.'}</div>`;
            }
            return repos.map((repo) => {
              const current = repo.owner.login === state.repo.owner && repo.name === state.repo.name;
              return html`<button
                class=${'repo-picker-item' + (current ? ' current' : '')}
                onClick=${() => void selectAccountRepo(repo)}
                title=${repo.description || repo.full_name}
              >
                <span class="repo-item-main">
                  <span class="repo-full-name y-truncate">${repo.full_name}</span>
                  ${repo.description ? html`<span class="repo-description y-truncate">${repo.description}</span>` : null}
                </span>
                <span class="repo-item-meta">${repo.private ? '🔒' : ''}${current ? ' ✓' : ''}</span>
              </button>`;
            });
          }}
        </div>
      `}
    </section>
  ` : null;
}

function sidebar() {
  return html`<aside class="gh-sidebar y-sidebar">
    <button class="sidebar-brand" aria-haspopup="dialog" aria-expanded=${() => state.repoPickerOpen} title="Switch repository" onClick=${toggleRepoPicker}>
      <span class="brand-mark">🐙</span>
      <span class="brand-repo">
        <span class="brand-owner y-truncate">${() => state.repo.owner}</span>
        <span class="brand-name y-truncate">${() => state.repo.name}</span>
      </span>
      <span class=${() => 'brand-chevron' + (state.repoPickerOpen ? ' open' : '')}>⌄</span>
    </button>
    ${repoPicker()}
    <nav class="sidebar-nav">
      ${NAV.map((n) => html`
        <button class=${() => 'nav-item' + (state.section === n.id ? ' active' : '')} onClick=${() => selectSection(n.id)}>
          <span class="nav-icon">${n.icon}</span><span class="nav-label">${n.label}</span>
          ${() => n.id === 'issues' && state.repoInfo ? html`<span class="nav-count">${state.repoInfo.open_issues_count}</span>` : null}
        </button>`)}
    </nav>
    <div class="sidebar-foot">
      <button class=${() => 'nav-item' + (state.section === 'settings' ? ' active' : '')} onClick=${() => selectSection('settings')}>
        <span class="nav-icon">⚙️</span><span class="nav-label">Settings</span>
        ${() => hasToken() ? html`<span class="tok-dot" title="Signed in"></span>` : null}
      </button>
    </div>
  </aside>`;
}

function contentView() {
  return html`<main class="gh-main">
    <div class="main-topbar">
      <div class="topbar-title">${() => NAV.find((n) => n.id === state.section)?.label || 'Settings'}</div>
      <button class="y-btn y-btn-ghost y-btn-sm" title="Refresh" disabled=${() => state.loading} onClick=${() => void refreshAll()}>↻ <span class="refresh-label">Refresh</span></button>
    </div>
    <div class="main-body">
      ${() => {
        switch (state.section) {
          case 'overview': return overviewView();
          case 'issues': return issuesView();
          case 'pulls': return pullsView();
          case 'releases': return releasesView();
          case 'code': return codeView();
          case 'settings': return settingsView();
          default: return null;
        }
      }}
    </div>
    <div class="y-statusbar">
      <span>${() => `${state.repo.owner}/${state.repo.name}`}${() => state.user ? ` · @${state.user.login}` : hasToken() ? ' · signed in' : ' · read-only'}</span>
      <span>${() => state.rateLimit
        ? `API ${state.rateLimit.remaining}/${state.rateLimit.limit}${state.rateLimit.remaining === 0 ? ` · resets in ${resetCountdown(state.rateLimit.reset)}` : ''}`
        : ''}</span>
    </div>
  </main>`;
}

render(() => html`<div class="y-app gh-app">
  <div class="gh-layout">
    ${sidebar()}
    ${contentView()}
  </div>
</div>`, document.getElementById('app')!);

registerAppProtocol();

void (async () => {
  await bootstrapStorage();
  if (state.token) void refreshUser();
  await loadSection('overview', true);
})();
