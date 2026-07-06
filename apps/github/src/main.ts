import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import type { Section } from './types';
import { state, hasToken } from './store';
import { bootstrapStorage } from './storage';
import { selectSection, loadSection, refreshAll } from './actions';
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

function sidebar() {
  return html`<aside class="gh-sidebar y-sidebar">
    <div class="sidebar-brand">
      <span class="brand-mark">🐙</span>
      <div class="brand-repo">
        <div class="brand-owner y-truncate">${() => state.repo.owner}</div>
        <div class="brand-name y-truncate">${() => state.repo.name}</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${NAV.map((n) => html`
        <button class=${() => 'nav-item' + (state.section === n.id ? ' active' : '')} onClick=${() => selectSection(n.id)}>
          <span class="nav-icon">${n.icon}</span><span>${n.label}</span>
          ${() => n.id === 'issues' && state.repoInfo ? html`<span class="nav-count">${state.repoInfo.open_issues_count}</span>` : null}
        </button>`)}
    </nav>
    <div class="sidebar-foot">
      <button class=${() => 'nav-item' + (state.section === 'settings' ? ' active' : '')} onClick=${() => selectSection('settings')}>
        <span class="nav-icon">⚙️</span><span>Settings</span>
        ${() => hasToken() ? html`<span class="tok-dot" title="Token set"></span>` : null}
      </button>
    </div>
  </aside>`;
}

function content() {
  return html`<main class="gh-main">
    <div class="main-topbar">
      <div class="topbar-title">${() => NAV.find((n) => n.id === state.section)?.label || 'Settings'}</div>
      <button class="y-btn y-btn-ghost y-btn-sm" title="Refresh" disabled=${() => state.loading} onClick=${() => void refreshAll()}>↻ Refresh</button>
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
      <span>${() => `${state.repo.owner}/${state.repo.name}`}${() => hasToken() ? ' · 🔑 token' : ' · read-only'}</span>
      <span>${() => state.rateLimit
        ? `API ${state.rateLimit.remaining}/${state.rateLimit.limit}${state.rateLimit.remaining === 0 ? ` · resets in ${resetCountdown(state.rateLimit.reset)}` : ''}`
        : ''}</span>
    </div>
  </main>`;
}

render(() => html`<div class="y-app gh-app">
  <div class="gh-layout">
    ${sidebar()}
    ${content()}
  </div>
</div>`, document.getElementById('app')!);

registerAppProtocol();

void (async () => {
  await bootstrapStorage();
  await loadSection('overview', true);
})();
