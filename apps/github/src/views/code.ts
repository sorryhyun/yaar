import html from '@bundled/solid-js/html';
import { state } from '../store';
import { loadDir, openFile, closeFile, goUpDir, navigateCrumb } from '../actions';
import { formatBytes } from '../utils';
import type { ContentEntry } from '../types';
import { loadingBlock, emptyBlock, errorBlock, mdBody } from './common';

function breadcrumb() {
  const parts = state.codePath.split('/').filter(Boolean);
  return html`<div class="crumb">
    <button class="crumb-link" onClick=${() => void loadDir('')}>${state.repo.name}</button>
    ${parts.map((p, idx) => html`<span class="crumb-sep">/</span><button class="crumb-link" onClick=${() => navigateCrumb(idx)}>${p}</button>`)}
  </div>`;
}

function entryRow(e: ContentEntry) {
  const icon = e.type === 'dir' ? '📁' : '📄';
  return html`<div class="code-row y-list-item" onClick=${() => e.type === 'dir' ? void loadDir(e.path) : void openFile(e)}>
    <span class="code-icon">${icon}</span>
    <span class="y-truncate y-flex-1">${e.name}</span>
    ${e.type === 'file' ? html`<span class="y-text-dim y-text-xs">${formatBytes(e.size)}</span>` : null}
  </div>`;
}

function fileView() {
  return html`<div class="file-view">
    <div class="file-hdr">
      <button class="y-btn y-btn-ghost y-btn-sm" onClick=${() => closeFile()}>← Back to files</button>
      <strong class="y-truncate">${() => state.fileName}</strong>
      ${() => state.fileDownloadUrl ? html`<a class="ext-link" href=${state.fileDownloadUrl} target="_blank" rel="noopener">Raw ↗</a>` : null}
    </div>
    <div class="file-content y-scroll">
      ${() => {
        if (state.fileBinary) return emptyBlock('📦', 'Binary or large file — open Raw to download.');
        if (state.fileIsMarkdown) return html`<div class="y-card">${mdBody(() => state.fileHtml)}</div>`;
        return html`<pre class="code-pre"><code>${() => state.fileText}</code></pre>`;
      }}
    </div>
  </div>`;
}

export function codeView() {
  return html`<div class="code-view">
    ${() => state.fileName ? fileView() : html`<div class="code-browser">
      <div class="code-toolbar">
        ${breadcrumb()}
        ${() => state.codePath ? html`<button class="y-btn y-btn-ghost y-btn-sm" onClick=${() => goUpDir()}>↑ Up</button>` : null}
      </div>
      <div class="code-list y-scroll">
        ${() => {
          if (state.codeLoading) return loadingBlock();
          if (state.error && state.codeEntries.length === 0) return errorBlock(state.error, () => void loadDir(state.codePath));
          if (state.codeEntries.length === 0) return emptyBlock('📂', 'Empty directory');
          return state.codeEntries.map((e) => entryRow(e));
        }}
      </div>
    </div>`}
  </div>`;
}
