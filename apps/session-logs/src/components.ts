import html from '@bundled/solid-js/html';
import type { SessionSummary } from './types';
import { state } from './store';
import { loadDetail } from './api';
import {
  formatDateTime,
  formatFull,
  durationBetween,
  providerLabel,
  providerCls,
} from './utils';

export const SessionItem = (s: SessionSummary) => {
  const isActive  = () => state.selectedId === s.sessionId;
  const isCurrent = () => state.currentSessionId === s.sessionId;

  return html`
    <div
      class=${() =>
        `y-list-item session-item${isActive() ? ' active' : ''}${isCurrent() ? ' current-session' : ''}`
      }
      onClick=${() => loadDetail(s.sessionId)}
    >
      <div class="session-id">
        ${() => isCurrent() ? '\u26a1\u00a0' + s.sessionId : s.sessionId}
      </div>
      <div class="session-meta">
        <span class=${() => providerCls(s.provider)}>${() => providerLabel(s.provider)}</span>
        <span class="session-datetime">${() => formatDateTime(s.createdAt)}</span>
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

export const DetailView = () => {
  const d = state.detail;
  if (!d) return null;

  const sid       = state.selectedId ?? '';
  const isCurrent = state.currentSessionId === sid;

  const knownKeys = new Set(['sessionId', 'createdAt', 'lastActivity', 'provider', 'agentCount']);
  const extraEntries = Object.entries(d).filter(([k]) => !knownKeys.has(k));

  return html`
    <div class="detail-content">

      <div class="detail-header">
        <div class="detail-session-id">${d.sessionId ?? sid}</div>
        ${isCurrent ? html`<span class="current-chip">⚡ Current Session</span>` : null}
      </div>

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
          <div class="field-value mono">${formatFull(d.createdAt)}</div>
        </div>

        <div class="detail-field">
          <div class="y-label field-label">Last Activity</div>
          <div class="field-value mono">${formatFull(d.lastActivity)}</div>
        </div>

        <div class="detail-field span-2">
          <div class="y-label field-label">Duration</div>
          <div class="field-value">⏱ ${durationBetween(d.createdAt, d.lastActivity)}</div>
        </div>

      </div>

      ${extraEntries.length > 0 ? html`
        <div class="raw-section">
          <div class="y-label raw-section-title">Extra Fields</div>
          <pre class="raw-json">${JSON.stringify(
            Object.fromEntries(extraEntries), null, 2
          )}</pre>
        </div>
      ` : null}

      <div class="raw-section">
        <div class="y-label raw-section-title">Raw JSON</div>
        <pre class="raw-json">${JSON.stringify(d, null, 2)}</pre>
      </div>

    </div>
  `;
};
