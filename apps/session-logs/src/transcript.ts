import html from '@bundled/solid-js/html';
import { For } from '@bundled/solid-js';
import type { ParsedMessage } from './types';
import { state } from './store';
import { formatTime } from './utils';
import {
  toolSummary,
  shortToolName,
  identifyingParam,
  middleTruncate,
  splitTarget,
  firstLine,
  looksLikeError,
} from './summarize';

/** Role → header label + CSS class (drives the left color bar & label color). */
const ROLE_META: Record<string, { label: string; cls: string }> = {
  user: { label: 'User', cls: 'role-user' },
  assistant: { label: 'Assistant', cls: 'role-assistant' },
};

/** Pretty-print any value as a JSON/text string. */
function pretty(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

type Seg = { code: boolean; text: string };

/** Split content into alternating text / fenced-code segments. */
function segments(content: string): Seg[] {
  const parts = String(content ?? '').split(/```/);
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
      ${(seg: Seg) =>
        seg.code
          ? html`<pre class="msg-code y-font-mono">${seg.text}</pre>`
          : html`<div class="msg-para">${seg.text}</div>`}
    </${For}>
  </div>
`;

// ── Compact log rows ──────────────────────────────────────
//
// Everything that is not prose (tool calls, results, reasoning, actions, UI
// interactions) renders as ONE line: time · verb chip · target. The row itself
// is the disclosure control — no separate "View input" box — so a screenful
// shows the shape of a session rather than four tool calls.

interface RowSpec {
  cls: string;
  verb: string;
  /** Secondary identifier shown before the target (e.g. the tool name on a result). */
  name?: string;
  target: string;
  /** Full text revealed on expand. Absent → the row is not expandable. */
  detail?: string;
  time?: string;
  agent?: string | null;
}

const LogRow = (r: RowSpec) => {
  // Hard cap first (a pathological param must not put 5KB in the DOM), then
  // split so CSS clips the head and the tail stays whole.
  const target = middleTruncate(r.target, 300);
  const { head: tHead, tail: tTail } = splitTarget(target);

  const head = html`
    <span class="log-time y-font-mono">${r.time ?? ''}</span>
    <span class="log-verb y-font-mono">${r.verb}</span>
    ${r.name ? html`<span class="log-name y-font-mono">${r.name}</span>` : null}
    <span class="log-target y-font-mono" title=${r.agent ? `${r.target}\n— ${r.agent}` : r.target}
      ><span class="log-target-head">${tHead}</span
      ><span class="log-target-tail">${tTail}</span></span
    >
    ${r.agent ? html`<span class="log-agent y-font-mono">${r.agent}</span>` : null}
  `;

  // No payload to reveal: a plain row, without a disclosure marker.
  if (!r.detail) {
    return html`<div class=${`log-row log-static ${r.cls}`}>${head}</div>`;
  }

  return html`
    <details class=${`log-row ${r.cls}`}>
      <summary class="log-summary">${head}</summary>
      <pre class="log-detail y-font-mono">${r.detail}</pre>
    </details>
  `;
};

function rowFor(m: ParsedMessage): RowSpec | null {
  const time = m.timestamp ? formatTime(m.timestamp) : '';
  const agent = m.agentId ?? null;

  switch (m.type) {
    case 'tool_use': {
      const { verb, target } = toolSummary(m.toolName, m.toolInput);
      return {
        cls: 'role-tool',
        verb,
        target,
        detail: m.toolInput != null ? pretty(m.toolInput) : undefined,
        time,
        agent,
      };
    }
    case 'tool_result': {
      const failed = looksLikeError(m.content);
      return {
        cls: failed ? 'role-error' : 'role-result',
        verb: failed ? 'error' : 'result',
        name: m.toolName ? shortToolName(m.toolName) : undefined,
        target: firstLine(m.content),
        detail: m.content || undefined,
        time,
        agent,
      };
    }
    case 'thinking':
      return {
        cls: 'role-thinking',
        verb: 'think',
        target: firstLine(m.content),
        detail: m.content || undefined,
        time,
        agent,
      };
    case 'action': {
      const act = m.action as Record<string, unknown> | undefined;
      const type = act?.type != null ? String(act.type) : '';
      const rest = act ? { ...act } : {};
      delete rest.type;
      return {
        cls: 'role-action',
        verb: 'action',
        name: type || undefined,
        target: identifyingParam(rest),
        detail: m.action != null ? pretty(m.action) : undefined,
        time,
        agent,
      };
    }
    case 'interaction':
      return {
        cls: 'role-interaction',
        verb: 'ui',
        target: m.interaction ?? '',
        time,
        agent,
      };
    default:
      return null;
  }
}

/** A prose turn (user / assistant) — still a card, since the text is the point. */
const ProseCard = (m: ParsedMessage) => {
  const meta = ROLE_META[m.type] ?? { label: m.type, cls: 'role-unknown' };
  return html`
    <div class=${`msg-card ${meta.cls}`}>
      <div class="msg-head">
        <span class="msg-role">${meta.label}</span>
        ${m.agentId ? html`<span class="msg-agent y-font-mono">${m.agentId}</span>` : null}
        ${m.timestamp
          ? html`<span class="msg-time y-font-mono">${formatTime(m.timestamp)}</span>`
          : null}
      </div>
      <div class="msg-body">${m.content ? ContentBlock(m.content) : null}</div>
    </div>
  `;
};

/** A single turn: a dense log row for machinery, a card for prose. */
export const MessageCard = (m: ParsedMessage) => {
  const row = rowFor(m);
  return row ? LogRow(row) : ProseCard(m);
};

/**
 * The ONE source of turns.
 *
 * The count badge and the list must read the same accessor. When they read
 * separate expressions they can disagree — and they did: a render throw in the
 * list left the badge showing "6874 turns" above a raw-markdown dump, because
 * the badge's memo had already committed and the list's had aborted.
 */
const turns = (): ParsedMessage[] => (Array.isArray(state.messages) ? state.messages : []);

/**
 * Render one turn, never throwing.
 *
 * The list render happens synchronously inside `setState`, so an exception in
 * a single row unwinds past `For` and aborts the whole DOM update — leaving
 * whatever was on screen before. One malformed entry must cost one row.
 */
const SafeMessageCard = (m: ParsedMessage) => {
  try {
    return MessageCard(m);
  } catch (e) {
    console.error('Failed to render turn', m?.type, e);
    return html`<div class="log-row log-static role-error">
      <span class="log-verb y-font-mono">render</span>
      <span class="log-target y-font-mono">could not display this ${m?.type ?? 'entry'}</span>
    </div>`;
  }
};

/** Transcript section: structured cards when available, raw markdown fallback. */
export const TranscriptSection = () => html`
  <div class="transcript-section">
    <div class="transcript-toolbar">
      <span class="y-label transcript-title">Transcript</span>
      ${() =>
        turns().length
          ? html`<span class="msg-count y-font-mono">${turns().length} turns</span>`
          : null}
    </div>
    <div class="transcript-body">
      ${() => {
        if (turns().length) {
          return html`
            <${For} each=${turns}>
              ${(m: ParsedMessage) => SafeMessageCard(m)}
            </${For}>
          `;
        }
        if (state.transcript) {
          // Falling back to the server-rendered markdown is legitimate, but it
          // used to be silent — indistinguishable from a broken renderer. Say
          // why there are no structured turns.
          return html`
            ${() =>
              state.messagesError
                ? html`<div class="transcript-note">
                    Showing the raw transcript — ${state.messagesError}
                  </div>`
                : null}
            <pre class="transcript-raw y-font-mono">${state.transcript}</pre>
          `;
        }
        return html`<div class="transcript-loading">
          <span class="y-spinner"></span> Loading transcript…
        </div>`;
      }}
    </div>
  </div>
`;
