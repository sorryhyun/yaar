import html from '@bundled/solid-js/html';
import { onCleanup } from '@bundled/solid-js';
import { downloadBlob } from '@bundled/yaar';
import type { SessionSummary } from './types';
import { state } from './store';
import { selectConversation, selectMonitor, requestMonitorBadge } from './api';
import { ALL, conversationsOf, type Conversation } from './conversations';
import { monitorLabel } from './monitor';
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

/** One observer for every row: a row asks for its badge the first time it is on screen. */
// Created on first use: the build imports this module outside a browser to read the protocol.
const onVisible = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;
function rowObserver(): IntersectionObserver {
  return (observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      onVisible.get(e.target)?.();
      observer?.unobserve(e.target);
    }
  }));
}

/**
 * Is this row what the transcript shows? A row is one monitor's one conversation, so a
 * wider scope (the whole log, or every conversation of a monitor) lights up every row
 * inside it.
 */
function inView(c: Conversation): boolean {
  if (state.selectedId !== c.sessionId) return false;
  if (state.selectedMonitor === ALL || c.monitor === ALL) return true;
  if (state.selectedMonitor !== c.monitor) return false;
  return state.selectedConversation == null || state.selectedConversation === c.epoch;
}

/** One row of the session list: a monitor's conversation, or a whole log too old to split. */
export const ConversationItem = (c: Conversation, s: SessionSummary) => {
  const whole = c.monitor === ALL;
  const isCurrent = () => state.currentSessionId === c.sessionId && c.latest;
  // Only a whole-log row needs a badge: a split row names its one monitor itself.
  const badge = () => {
    const ids = state.monitorBadges[s.sessionId];
    return ids?.length ? ids.map((id) => `M${id}`).join(' · ') : '';
  };
  const watch = (el: HTMLElement) => {
    if (!whole) return;
    onVisible.set(el, () => requestMonitorBadge(s));
    rowObserver().observe(el);
    onCleanup(() => rowObserver().unobserve(el));
  };

  const open = () => {
    void selectConversation(c);
    // Narrow layout: the list is an overlay on top of the transcript, so
    // picking a session has to get out of the way to show it.
    if (narrow()) closeDrawer();
  };

  return html`
    <div
      class=${() =>
        `y-list-item session-item${inView(c) ? ' active' : ''}${isCurrent() ? ' current-session' : ''}`}
      onClick=${open}
      ref=${watch}
    >
      <div class="session-id y-font-mono">
        ${() => (isCurrent() ? '⚡ ' + c.sessionId : c.sessionId)}
      </div>
      <div class="session-meta">
        ${whole
          ? null
          : html`<span class="monitor-badge y-font-mono" title=${monitorLabel(c.monitor)}
              >M${c.monitor}</span
            >`}
        ${c.count > 1
          ? html`<span
              class="conversation-badge y-font-mono"
              title=${`Conversation ${c.epoch + 1} of ${c.count} — split by a reset`}
              >↺ ${c.epoch + 1}/${c.count}</span
            >`
          : null}
        <span class=${() => providerCls(s.provider)}>${() => providerLabel(s.provider)}</span>
        <span class="session-datetime y-font-mono">${() => formatDateTime(c.start)}</span>
        ${() =>
          whole && badge()
            ? html`<span class="monitor-badge y-font-mono" title="Monitors in this session"
                >${badge}</span
              >`
            : null}
        ${whole ? html`<span class="agent-count">🤖 ${() => s.agentCount ?? 0}</span>` : null}
      </div>
    </div>
  `;
};

/** The conversation the transcript is scoped to, when it is exactly one. */
function scopedConversation(): Conversation | null {
  if (state.selectedMonitor === ALL || state.selectedConversation == null) return null;
  const s = state.sessions.find((x) => x.sessionId === state.selectedId);
  if (!s) return null;
  return (
    conversationsOf(s).find(
      (c) => c.monitor === state.selectedMonitor && c.epoch === state.selectedConversation,
    ) ?? null
  );
}

/** What the transcript holds, and the way back out to the whole log. */
const ScopeStrip = () => {
  const label = () => {
    if (state.selectedMonitor === ALL) return null;
    const c = scopedConversation();
    const conv =
      c && c.count > 1
        ? ` · conversation ${c.epoch + 1} of ${c.count}`
        : state.selectedConversation == null
          ? ' · every conversation'
          : '';
    return `${monitorLabel(state.selectedMonitor)}${conv}`;
  };
  return () =>
    label()
      ? html`<div class="scope-strip">
          <span class="meta-chip scope-chip y-font-mono">${label}</span>
          <button
            class="y-btn y-btn-sm y-btn-ghost"
            onClick=${() => selectMonitor(ALL)}
            title="Show every monitor and every conversation in this log"
          >
            Whole log
          </button>
        </div>`
      : null;
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
  <div class="detail-grid y-scroll">
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
          <span class="meta-chip y-font-mono"
            >${() => {
              const c = scopedConversation();
              return c ? formatRange(c.start, c.end) : formatRange(d.createdAt, d.lastActivity);
            }}</span
          >
          <span class="meta-chip"
            >⏱
            ${() => {
              const c = scopedConversation();
              return c
                ? durationBetween(c.start, c.end)
                : durationBetween(d.createdAt, d.lastActivity);
            }}</span
          >
          <button
            class="y-btn y-btn-sm y-btn-ghost meta-toggle"
            onClick=${toggleMeta}
            title="Toggle full metadata"
          >
            ${() => (metaExpanded() ? '▴ Less' : '▾ Details')}
          </button>
        </div>

        ${ScopeStrip()} ${() => (metaExpanded() ? MetaCards(d as Record<string, any>) : null)}
      </div>

      ${TranscriptSection()}
    </div>
  `;
};
