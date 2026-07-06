import html from '@bundled/solid-js/html';
import { state } from '../store';
import { loadReleases } from '../actions';
import { renderMarkdown } from '../markdown';
import { formatDate, formatBytes, compactNum } from '../utils';
import { loadingBlock, emptyBlock, errorBlock, mdBody } from './common';

export function releasesView() {
  return html`<div class="section-scroll y-scroll">
    ${() => {
      if (state.releasesLoading) return loadingBlock('Loading releases…');
      if (state.error && state.releases.length === 0) return errorBlock(state.error, () => void loadReleases());
      if (state.releases.length === 0) return emptyBlock('🏷️', 'No releases published');
      return html`<div class="releases-body">
        ${state.releases.map((r) => html`
          <div class="y-card release-card">
            <div class="release-hdr">
              <div class="release-title">
                <a href=${r.html_url} target="_blank" rel="noopener">${r.name || r.tag_name}</a>
                <span class="y-badge y-badge-accent">${r.tag_name}</span>
                ${r.prerelease ? html`<span class="y-badge y-badge-warning">pre-release</span>` : null}
                ${r.draft ? html`<span class="y-badge">draft</span>` : null}
              </div>
              <span class="y-text-dim">${formatDate(r.published_at || r.created_at)}</span>
            </div>
            ${r.body ? html`<div class="release-notes">${mdBody(() => renderMarkdown(r.body))}</div>` : html`<div class="y-text-muted">No release notes.</div>`}
            ${r.assets && r.assets.length ? html`<div class="assets">
              <div class="y-label">Assets</div>
              ${r.assets.map((a) => html`
                <a class="asset-row" href=${a.browser_download_url} target="_blank" rel="noopener">
                  <span class="y-truncate">⬇️ ${a.name}</span>
                  <span class="y-text-dim">${formatBytes(a.size)} · ${compactNum(a.download_count)} ⬇</span>
                </a>`)}
            </div>` : null}
          </div>`)}
      </div>`;
    }}
  </div>`;
}
