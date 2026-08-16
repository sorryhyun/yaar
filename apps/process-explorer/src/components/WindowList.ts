export {};

import html from '@bundled/solid-js/html';
import { closeWindow, windows } from '../data';
import type { WindowInfo } from '../types';
import { ProcessList } from './ProcessList';

function WindowRow(props: { win: WindowInfo }) {
  const w = () => props.win;
  return html`
    <div class="process-row">
      <div class="process-info">
        <div class="process-detail">
          <div class="process-title">
            ${() => w().locked ? html`<span class="lock-icon">&#128274; </span>` : null}${() =>
              w().title || '(untitled)'}
          </div>
          <div class="process-meta">
            <span class="y-badge">${() => w().renderer}</span>
            ${() => (w().appId ? html`<span class="y-badge">${w().appId}</span>` : null)}
            <span>${() => w().size}</span>
          </div>
        </div>
      </div>
      <div class="process-actions">
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => closeWindow(w().id)}
          title="Close window"
        >
          Close
        </button>
      </div>
    </div>
  `;
}

export function WindowList() {
  return html`
    <${ProcessList} each=${windows} icon="□" emptyText="No windows open"
      >${(win: WindowInfo) => html`<${WindowRow} win=${win} />`}</
    >
  `;
}
