import html from '@bundled/solid-js/html';
import { state } from '../store';
import { loadPulls, setPullFilter, openPull, closeActivePull } from '../actions';
import { renderMarkdown } from '../markdown';
import { timeAgo } from '../utils';
import { avatar, loadingBlock, emptyBlock, errorBlock, mdBody } from './common';

function prBadge(p: { state: string; merged: boolean }) {
  if (p.merged) return html`<span class="y-badge y-badge-accent">Merged</span>`;
  return p.state === 'open'
    ? html`<span class="y-badge y-badge-success">Open</span>`
    : html`<span class="y-badge y-badge-error">Closed</span>`;
}

function pullList() {
  return html`<div class="list-pane">
    <div class="list-toolbar">
      <div class="y-tabs filter-tabs">
        <button class=${() => 'y-tab' + (state.pullFilter === 'open' ? ' active' : '')} onClick=${() => setPullFilter('open')}>Open</button>
        <button class=${() => 'y-tab' + (state.pullFilter === 'closed' ? ' active' : '')} onClick=${() => setPullFilter('closed')}>Closed</button>
      </div>
    </div>
    <div class="list-scroll y-scroll">
      ${() => {
        if (state.pullsLoading) return loadingBlock();
        if (state.error && state.pulls.length === 0) return errorBlock(state.error, () => void loadPulls());
        if (state.pulls.length === 0) return emptyBlock('🔀', `No ${state.pullFilter} pull requests`);
        return state.pulls.map((p) => html`
          <div class=${() => 'issue-row y-list-item' + (state.activePull?.number === p.number ? ' active' : '')}
            onClick=${() => void openPull(p.number)}>
            <div class="row-main">
              <div class="row-title">
                <span class=${'state-dot ' + (p.merged ? 'merged' : p.state)}></span>
                <span class="y-truncate">${p.title}</span>
              </div>
              <div class="row-meta y-text-dim">#${p.number} · ${p.user?.login || ''} · ${timeAgo(p.updated_at)}</div>
            </div>
          </div>`);
      }}
    </div>
  </div>`;
}

function pullDetail() {
  return html`<div class="detail-pane y-scroll">
    ${() => {
      const p = state.activePull;
      if (!p) return emptyBlock('👈', 'Select a pull request to view details');
      return html`<div class="detail-body">
        <div class="detail-head">
          <button class="y-btn y-btn-ghost y-btn-sm back-btn" onClick=${() => closeActivePull()}>← Back</button>
          <a class="ext-link" href=${p.html_url} target="_blank" rel="noopener">Open on GitHub ↗</a>
        </div>
        <h2 class="detail-title">${p.title} <span class="y-text-dim">#${p.number}</span></h2>
        <div class="detail-sub">
          ${prBadge(p)}
          ${avatar(p.user)}<span>${p.user?.login || ''}</span>
          <span class="y-text-dim">${p.head?.ref} → ${p.base?.ref}</span>
        </div>
        <div class="pr-stats">
          <span class="y-badge">📄 ${p.changed_files ?? '?'} files</span>
          <span class="y-badge">➕️ ${p.commits ?? '?'} commits</span>
          ${p.additions != null ? html`<span class="y-badge y-badge-success">+${p.additions}</span>` : null}
          ${p.deletions != null ? html`<span class="y-badge y-badge-error">-${p.deletions}</span>` : null}
        </div>
        ${state.pullDetailLoading && !p.changed_files ? loadingBlock() : html`<div class="y-card comment-card">
          ${p.body ? mdBody(() => renderMarkdown(p.body)) : html`<span class="y-text-muted">No description provided.</span>`}
        </div>`}
        <div class="comments-hdr y-label">Commits (${state.activePullCommits.length})</div>
        <div class="y-card commit-list">
          ${state.activePullCommits.length === 0 ? html`<span class="y-text-muted">No commits loaded.</span>` : null}
          ${state.activePullCommits.map((c) => html`
            <div class="commit-row">
              <span class="y-font-mono y-text-accent">${c.sha.slice(0, 7)}</span>
              <span class="y-truncate">${(c.commit?.message || '').split('\n')[0]}</span>
              <span class="y-text-dim">${c.commit?.author?.name || ''}</span>
            </div>`)}
        </div>
        <div class="comments-hdr y-label">${state.activePullComments.length} Comment(s)</div>
        ${state.activePullComments.map((c) => html`
          <div class="y-card comment-card">
            <div class="comment-hdr">${avatar(c.user)}<strong>${c.user?.login || ''}</strong><span class="y-text-dim">${timeAgo(c.created_at)}</span></div>
            ${mdBody(() => renderMarkdown(c.body))}
          </div>`)}
      </div>`;
    }}
  </div>`;
}

export function pullsView() {
  return html`<div class="split-view">${pullList()}${pullDetail()}</div>`;
}
