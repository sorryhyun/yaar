import html from '@bundled/solid-js/html';
import { state } from '../store';
import { loadOverview } from '../actions';
import { compactNum, formatDate } from '../utils';
import { loadingBlock, errorBlock, mdBody } from './common';

function stat(icon: string, label: string, value: number) {
  return html`<div class="stat-card">
    <div class="stat-value">${icon} ${compactNum(value)}</div>
    <div class="stat-label">${label}</div>
  </div>`;
}

export function overviewView() {
  return html`<div class="section-scroll y-scroll">
    ${() => {
      if (state.loading && !state.repoInfo) return loadingBlock('Loading repository…');
      if (state.error && !state.repoInfo) return errorBlock(state.error, () => void loadOverview());
      const r = state.repoInfo;
      if (!r) return errorBlock('No repository data', () => void loadOverview());
      return html`<div class="overview-body">
        <div class="overview-head">
          <div class="repo-title">
            <a href=${r.html_url} target="_blank" rel="noopener">${r.full_name}</a>
          </div>
          ${r.description ? html`<div class="repo-desc">${r.description}</div>` : null}
          <div class="repo-meta">
            ${r.language ? html`<span class="y-badge">${r.language}</span>` : null}
            ${r.license ? html`<span class="y-badge">${r.license.name}</span>` : null}
            <span class="y-text-dim">Updated ${formatDate(r.updated_at)}</span>
          </div>
          ${r.topics && r.topics.length ? html`<div class="label-row">${r.topics.map((t) => html`<span class="y-badge y-badge-accent">${t}</span>`)}</div>` : null}
        </div>
        <div class="stat-grid">
          ${stat('⭐', 'Stars', r.stargazers_count)}
          ${stat('🍴', 'Forks', r.forks_count)}
          ${stat('👁', 'Watchers', r.subscribers_count)}
          ${stat('⚠️', 'Open issues', r.open_issues_count)}
        </div>
        <div class="readme-card y-card">
          <div class="card-hdr">📖 README</div>
          ${() => state.readmeMissing
            ? html`<div class="y-text-muted">No README found for this repository.</div>`
            : mdBody(() => state.readmeHtml)}
        </div>
      </div>`;
    }}
  </div>`;
}
