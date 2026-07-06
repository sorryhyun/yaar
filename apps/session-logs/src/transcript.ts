import html from '@bundled/solid-js/html';
import { For } from '@bundled/solid-js';
import type { ParsedMessage } from './types';
import { state } from './store';
import { formatTime } from './utils';

/** Role → header label + CSS class (drives the left color bar & label color). */
const ROLE_META: Record<string, { label: string; cls: string }> = {
  user:        { label: 'User',        cls: 'role-user' },
  assistant:   { label: 'Assistant',   cls: 'role-assistant' },
  thinking:    { label: 'Thinking',    cls: 'role-thinking' },
  tool_use:    { label: 'Tool Call',   cls: 'role-tool' },
  tool_result: { label: 'Tool Result', cls: 'role-result' },
  action:      { label: 'Action',      cls: 'role-action' },
  interaction: { label: 'Interaction', cls: 'role-interaction' },
};

/** Pretty-print any value as a JSON/text string. */
function pretty(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

type Seg = { code: boolean; text: string };

/** Split content into alternating text / fenced-code segments. */
function segments(content: string): Seg[] {
  const parts = content.split(/```/);
  const segs: Seg[] = [];
  parts.forEach((t, i) => {
    const code = i % 2 === 1;
    let text = t;
    if (code) text = text.replace(/^[a-zA-Z0-9_+-]*\n/, ''); // drop language hint line
    if (!code) {
      text = text.replace(/^\n+/, '').replace(/\n+$/, '');
      if (!text) return;
    }
    segs.push({ code, text });
  });
  return segs.length ? segs : [{ code: false, text: content }];
}

/** Prose content that preserves fenced code blocks as mono blocks. */
const ContentBlock = (content: string) => html`
  <div class="msg-text">
    <${For} each=${() => segments(content)}>
      ${(seg: Seg) => seg.code
        ? html`<pre class="msg-code">${seg.text}</pre>`
        : html`<div class="msg-para">${seg.text}</div>`
      }
    </${For}>
  </div>
`;

/** Collapsible monospace payload (JSON / long text). */
const Collapsible = (label: string, body: string) => html`
  <details class="msg-collapse">
    <summary class="msg-summary">${label}</summary>
    <pre class="msg-code">${body}</pre>
  </details>
`;

function MessageBody(m: ParsedMessage) {
  switch (m.type) {
    case 'user':
    case 'assistant':
      return m.content ? ContentBlock(m.content) : null;
    case 'tool_result':
      if (!m.content) return null;
      return m.content.length > 280
        ? Collapsible('View result', m.content)
        : html`<pre class="msg-code">${m.content}</pre>`;
    case 'thinking':
      return m.content ? Collapsible('View reasoning', m.content) : null;
    case 'tool_use':
      return m.toolInput != null ? Collapsible('View input', pretty(m.toolInput)) : null;
    case 'action':
      return m.action != null ? Collapsible('View payload', pretty(m.action)) : null;
    case 'interaction':
      return m.interaction ? html`<code class="msg-inline">${m.interaction}</code>` : null;
    default:
      return m.content ? ContentBlock(m.content) : null;
  }
}

/** A single turn rendered as a card with a colored role header. */
export const MessageCard = (m: ParsedMessage) => {
  const meta = ROLE_META[m.type] ?? { label: m.type, cls: 'role-unknown' };

  let sub = '';
  if (m.type === 'tool_use' || m.type === 'tool_result') sub = m.toolName ?? '';
  else if (m.type === 'action') sub = String((m.action as Record<string, unknown> | undefined)?.type ?? '');

  return html`
    <div class=${`msg-card ${meta.cls}`}>
      <div class="msg-head">
        <span class="msg-role">${meta.label}</span>
        ${sub ? html`<span class="msg-sub">${sub}</span>` : null}
        ${m.agentId ? html`<span class="msg-agent">${m.agentId}</span>` : null}
        ${m.timestamp ? html`<span class="msg-time">${formatTime(m.timestamp)}</span>` : null}
      </div>
      <div class="msg-body">${MessageBody(m)}</div>
    </div>
  `;
};

/** Transcript section: structured cards when available, raw markdown fallback. */
export const TranscriptSection = () => html`
  <div class="transcript-section">
    <div class="transcript-toolbar">
      <span class="y-label transcript-title">Transcript</span>
      ${() => state.messages && state.messages.length
        ? html`<span class="msg-count">${state.messages.length} turns</span>`
        : null
      }
    </div>
    <div class="transcript-body">
      ${() => {
        if (state.messages && state.messages.length) {
          return html`
            <${For} each=${() => state.messages ?? []}>
              ${(m: ParsedMessage) => MessageCard(m)}
            </${For}>
          `;
        }
        if (state.transcript) {
          return html`<pre class="transcript-raw">${state.transcript}</pre>`;
        }
        return html`<div class="transcript-loading"><span class="y-spinner"></span> Loading transcript…</div>`;
      }}
    </div>
  </div>
`;
