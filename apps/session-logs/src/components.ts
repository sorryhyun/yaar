import html from '@bundled/solid-js/html';
import { downloadBlob } from '@bundled/yaar';
import type { SessionSummary } from './types';
import { state } from './store';
import { loadDetail } from './api';
import { TranscriptSection } from './transcript';
import { metaExpanded, toggleMeta, narrow, closeDrawer } from './ui';
import {
  formatDateTime,
  formatFull,
  formatRange,
  durationBetween,
  providerLabel,
  providerCls,
} from './utils';

export const SessionItem = (s: SessionSummary) => {
  const isActive = () => state.selectedId === s.sessionId;
  const isCurrent = () => state.currentSessionId === s.sessionId;

  const open = () => {
    void loadDetail(s.sessionId);
    // Narrow layout: the list is an overlay on top of the transcript, so
    // picking a session has to get out of the way to show it.
    if (narrow()) closeDrawer();
  };

  return html`
    <div
      class=${() =>
        `y-list-item session-item${isActive() ? ' active' : ''}${isCurrent() ? ' current-session' : ''}`}
      onClick=${open}
    >
      <div class="session-id y-font-mono">
        ${() => (isCurrent() ? '⚡ ' + s.sessionId : s.sessionId)}
      </div>
      <div class="session-meta">
        <span class=${() => providerCls(s.provider)}>${() => providerLabel(s.provider)}</span>
        <span class="session-datetime y-font-mono">${() => formatDateTime(s.createdAt)}</span>
        <span class="agent-count">🤖 ${() => s.agentCount ?? 0}</span>
      </div>
    </div>
  `;
};

export const DetailEmpty = () => html`
  <div class="y-empty detail-empty">
    <div class="y-empty-icon">📋</div>
    <div class="empty-title">No session selected</div>
    <div class="empty-sub">Click a session in the list to view its details</div>
  </div>
`;

/** Full card grid — the opt-in expansion behind the compact strip. */
const MetaCards = (d: Record<string, any>) => html`
  <div class="detail-grid">
    <div class="detail-field">
      <div class="y-label field-label">Provider</div>
      <div class="field-value">
        <span class=${providerCls(d.provider)}>${providerLabel(d.provider)}</span>
      </div>
    </div>

    <div class="detail-field">
      <div class="y-label field-label">Agents</div>
      <div class="field-value agent-value">🤖 ${d.agentCount ?? '-'}</div>
    </div>

    <div class="detail-field">
      <div class="y-label field-label">Created</div>
      <div class="field-value mono y-font-mono">${formatFull(d.createdAt)}</div>
    </div>

    <div class="detail-field">
      <div class="y-label field-label">Last Activity</div>
      <div class="field-value mono y-font-mono">${formatFull(d.lastActivity)}</div>
    </div>

    <div class="detail-field span-2">
      <div class="y-label field-label">Duration</div>
      <div class="field-value">⏱ ${durationBetween(d.createdAt, d.lastActivity)}</div>
    </div>
  </div>
`;

export const DetailView = () => {
  const d = state.detail;
  if (!d) return null;

  const sid = state.selectedId ?? '';
  const isCurrent = state.currentSessionId === sid;

  const downloadLog = () => {
    const content = state.transcript ?? '';
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain' });
    downloadBlob(blob, `${sid}.md`);
  };

  return html`
    <div class="detail-content">
      <div class="detail-header">
        <div class="detail-header-top">
          <div class="detail-session-id y-font-mono" title=${d.sessionId ?? sid}>
            ${d.sessionId ?? sid}
          </div>
          ${isCurrent ? html`<span class="current-chip" title="Current session">⚡</span>` : null}
          <button
            class="y-btn y-btn-sm y-btn-ghost download-btn"
            onClick=${downloadLog}
            disabled=${() => !state.transcript}
            title="Download transcript"
          >
            ⬇
          </button>
        </div>

        <div class="meta-strip">
          <span class=${providerCls(d.provider)}>${providerLabel(d.provider)}</span>
          <span class="meta-chip">🤖 ${d.agentCount ?? 0} agents</span>
          <span class="meta-chip y-font-mono">${formatRange(d.createdAt, d.lastActivity)}</span>
          <span class="meta-chip">⏱ ${durationBetween(d.createdAt, d.lastActivity)}</span>
          <button
            class="y-btn y-btn-sm y-btn-ghost meta-toggle"
            onClick=${toggleMeta}
            title="Toggle full metadata"
          >
            ${() => (metaExpanded() ? '▴ Less' : '▾ Details')}
          </button>
        </div>

        ${() => (metaExpanded() ? MetaCards(d as Record<string, any>) : null)}
      </div>

      ${TranscriptSection()}
    </div>
  `;
};
