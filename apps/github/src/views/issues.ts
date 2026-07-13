import html from '@bundled/solid-js/html';
import { errMsg } from '@bundled/yaar';
import { state, setState, hasToken, showToast } from '../store';
import {
  loadIssues, setIssueFilter, openIssue, closeActiveIssue,
  createIssueAction, commentIssueAction, setIssueStateAction,
} from '../actions';
import { renderRepoMarkdown } from '../markdown';
import { timeAgo } from '../utils';
import { labelChips, avatar, loadingBlock, emptyBlock, errorBlock, mdBody } from './common';

let newTitleEl: HTMLInputElement | null = null;
let newBodyEl: HTMLTextAreaElement | null = null;
let commentEl: HTMLTextAreaElement | null = null;

function filteredIssues() {
  const q = state.issueSearch.trim().toLowerCase();
  if (!q) return state.issues;
  return state.issues.filter((i) =>
    i.title.toLowerCase().includes(q) ||
    String(i.number).includes(q) ||
    i.labels.some((l) => l.name.toLowerCase().includes(q)),
  );
}

async function submitNewIssue() {
  const title = newTitleEl?.value.trim() || '';
  const body = newBodyEl?.value || '';
  try {
    await createIssueAction(title, body);
    setState('showNewIssue', false);
    if (newTitleEl) newTitleEl.value = '';
    if (newBodyEl) newBodyEl.value = '';
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

async function submitComment(number: number) {
  const body = commentEl?.value || '';
  try {
    await commentIssueAction(number, body);
    if (commentEl) commentEl.value = '';
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

function tokenTip(): string {
  return hasToken() ? '' : 'requires token';
}

function issueList() {
  return html`<div class="list-pane">
    <div class="list-toolbar">
      <div class="y-tabs filter-tabs">
        <button class=${() => 'y-tab' + (state.issueFilter === 'open' ? ' active' : '')} onClick=${() => setIssueFilter('open')}>Open</button>
        <button class=${() => 'y-tab' + (state.issueFilter === 'closed' ? ' active' : '')} onClick=${() => setIssueFilter('closed')}>Closed</button>
      </div>
      <button
        class="y-btn y-btn-primary y-btn-sm"
        title=${() => tokenTip() || 'Create a new issue'}
        disabled=${() => !hasToken()}
        onClick=${() => setState('showNewIssue', true)}
      >+ New</button>
    </div>
    <div class="list-search">
      <input class="y-input" placeholder="Search issues…" value=${() => state.issueSearch}
        onInput=${(e: InputEvent) => setState('issueSearch', (e.target as HTMLInputElement).value)} />
    </div>
    <div class="list-scroll y-scroll">
      ${() => {
        if (state.issuesLoading) return loadingBlock();
        if (state.error && state.issues.length === 0) return errorBlock(state.error, () => void loadIssues());
        const items = filteredIssues();
        if (items.length === 0) return emptyBlock('📭', `No ${state.issueFilter} issues`);
        return items.map((i) => html`
          <button type="button" class=${() => 'issue-row y-list-item' + (state.activeIssue?.number === i.number ? ' active' : '')}
            aria-pressed=${() => state.activeIssue?.number === i.number}
            onClick=${() => void openIssue(i.number)}>
            <span class="issue-state-icon" aria-hidden="true">${i.state === 'open' ? '○' : '●'}</span>
            <span class="row-main">
              <span class="row-title" title=${i.title}>${i.title}</span>
              <span class="row-meta">
                <span class=${'issue-state-label ' + i.state}>${i.state === 'open' ? 'Open' : 'Closed'}</span>
                <span>#${i.number}</span>
                <span class="row-author">${i.user?.login || ''}</span>
                <span>${timeAgo(i.updated_at)}</span>
                ${i.comments ? html`<span>💬 ${i.comments}</span>` : null}
              </span>
              ${labelChips(i.labels)}
            </span>
          </button>`);
      }}
    </div>
  </div>`;
}

function issueDetail() {
  return html`<div class="detail-pane y-scroll">
    ${() => {
      const i = state.activeIssue;
      if (!i) return emptyBlock('👈', 'Select an issue to view details');
      const isOpen = i.state === 'open';
      return html`<div class="detail-body">
        <div class="detail-head">
          <button class="y-btn y-btn-ghost y-btn-sm back-btn" onClick=${() => closeActiveIssue()}>← Back</button>
          <a class="ext-link" href=${i.html_url} target="_blank" rel="noopener">Open on GitHub ↗</a>
        </div>
        <h2 class="detail-title">${i.title} <span class="y-text-dim">#${i.number}</span></h2>
        <div class="detail-sub">
          <span class=${'y-badge ' + (isOpen ? 'y-badge-success' : 'y-badge-error')}>${isOpen ? 'Open' : 'Closed'}</span>
          ${avatar(i.user)}<span>${i.user?.login || ''}</span>
          <span class="y-text-dim">opened ${timeAgo(i.created_at)}</span>
        </div>
        ${labelChips(i.labels)}
        ${state.issueDetailLoading && !i.body ? loadingBlock() : html`<div class="y-card comment-card">
          ${i.body ? mdBody(() => renderRepoMarkdown(i.body)) : html`<span class="y-text-muted">No description provided.</span>`}
        </div>`}
        <div class="comments-hdr y-label">${state.activeIssueComments.length} Comment(s)</div>
        ${state.activeIssueComments.map((c) => html`
          <div class="y-card comment-card">
            <div class="comment-hdr">${avatar(c.user)}<strong>${c.user?.login || ''}</strong><span class="y-text-dim">${timeAgo(c.created_at)}</span></div>
            ${mdBody(() => renderRepoMarkdown(c.body))}
          </div>`)}
        <div class="write-box">
          <textarea class="y-input write-area" placeholder=${() => hasToken() ? 'Leave a comment (markdown supported)…' : 'Set a token in Settings to comment'}
            disabled=${() => !hasToken()} ref=${(el: HTMLTextAreaElement) => { commentEl = el; }}></textarea>
          <div class="write-actions">
            <button class="y-btn y-btn-sm" title=${() => tokenTip() || 'Comment'} disabled=${() => !hasToken() || state.mutating}
              onClick=${() => void submitComment(i.number)}>Comment</button>
            ${isOpen
              ? html`<button class="y-btn y-btn-sm y-btn-danger" title=${() => tokenTip() || 'Close issue'} disabled=${() => !hasToken() || state.mutating}
                  onClick=${() => void setIssueStateAction(i.number, 'closed')}>Close issue</button>`
              : html`<button class="y-btn y-btn-sm" title=${() => tokenTip() || 'Reopen issue'} disabled=${() => !hasToken() || state.mutating}
                  onClick=${() => void setIssueStateAction(i.number, 'open')}>Reopen issue</button>`}
          </div>
        </div>
      </div>`;
    }}
  </div>`;
}

// NOTE: returns a bare accessor, not html`${...}`. A template literal with no
// static markup compiles to an invalid `new Function` body in solid-js/html
// ("Unexpected token '.'") the moment it is instantiated. Same pattern as
// repoPicker() in main.ts.
function newIssueModal() {
  return () => state.showNewIssue ? html`
    <div class="y-overlay" onClick=${(e: MouseEvent) => { if (e.target === e.currentTarget) setState('showNewIssue', false); }}>
      <div class="y-modal">
        <h3 class="modal-title">New Issue</h3>
        <input class="y-input" placeholder="Title" ref=${(el: HTMLInputElement) => { newTitleEl = el; }} />
        <textarea class="y-input write-area" placeholder="Description (markdown supported)…" ref=${(el: HTMLTextAreaElement) => { newBodyEl = el; }}></textarea>
        <div class="modal-actions">
          <button class="y-btn y-btn-ghost" onClick=${() => setState('showNewIssue', false)}>Cancel</button>
          <button class="y-btn y-btn-primary" disabled=${() => state.mutating} onClick=${() => void submitNewIssue()}>Create issue</button>
        </div>
      </div>
    </div>` : null;
}

export function issuesView() {
  return html`<div class=${() => 'split-view issues-split' + (state.activeIssue ? ' has-selection' : '')}>
    ${issueList()}
    ${issueDetail()}
    ${newIssueModal()}
  </div>`;
}
