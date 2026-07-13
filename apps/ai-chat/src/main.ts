import { createEffect, For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { v4 as uuid } from '@bundled/uuid';
import { app, errMsg } from '@bundled/yaar';
import './styles.css';
import {
  messages,
  isWaiting,
  inputValue,
  setInputValue,
  beginTurn,
  initStore,
} from './store';
import { registerProtocol } from './protocol';
import { formatTime } from './helpers';
import type { ChatMessage } from './types';

// ── Scroll helper ────────────────────────────────────────────────────

let messagesEl: HTMLDivElement | undefined;

function scrollToBottom(): void {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Sending ───────────────────────────────────────────────────────

/**
 * Synchronous re-entrancy guard. `isWaiting` is a signal, and a signal read is
 * the wrong tool for "has this handler already fired": two events dispatched in
 * the same tick (Enter keydown landing alongside a click, say) can both observe
 * the pre-update value and both emit an interaction — which the agent sees as
 * two user messages and answers twice. A plain boolean closes that window.
 */
let sending = false;

function sendMessage(): void {
  if (sending || isWaiting()) return;
  const text = inputValue().trim();
  if (!text) return;

  sending = true;
  try {
    const msgId = uuid();
    beginTurn(text, msgId);

    // Exactly one interaction per user message. `msgId` is the turn id the agent
    // must echo back as `replyTo`; the store drops any second reply for it.
    app?.sendInteraction({
      event: 'user_message',
      content: text,
      msgId,
      instructions:
        'Reply to the user message above. Call app_command addMessage EXACTLY ONCE with your full ' +
        `response, and include replyTo: "${msgId}" in its params. ` +
        'Do NOT call addMessage more than once and do NOT send any extra confirmation, ' +
        'acknowledgement, or "done" message afterwards — a single addMessage call fully completes ' +
        'this turn. If addMessage reports that the turn was already answered, STOP: the reply is ' +
        'already on screen and re-sending it will not change that. ' +
        'Your plain-text response is ignored by the chat UI; only addMessage renders a bubble.',
    });
  } finally {
    sending = false;
  }
}

// ── Input handlers ─────────────────────────────────────────────────

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function handleInput(e: Event): void {
  const ta = e.target as HTMLTextAreaElement;
  setInputValue(ta.value);
  // Auto-grow the textarea up to the max-height defined in CSS.
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ── Components ───────────────────────────────────────────────────

const TypingIndicator = () => html`
  <div class="typing-indicator">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>
`;

const MessageBubble = (props: { msg: ChatMessage }) => {
  const isUser = () => props.msg.role === 'user';
  const isLoading = () => props.msg.status === 'loading';

  return html`
    <div class=${() => `message-row ${isUser() ? 'user' : 'assistant'}`}>
      <div class="message-avatar">${() => (isUser() ? '🙂' : '🤖')}</div>
      <div class="message-col">
        <div class=${() => `message-bubble ${props.msg.status === 'error' ? 'error' : ''}`}>
          <${Show} when=${() => !isLoading()} fallback=${html`<${TypingIndicator} />`}>
            ${() => props.msg.content}
          <//>
        </div>
        <${Show} when=${() => !isLoading()}>
          <div class="message-time">${() => formatTime(props.msg.timestamp)}</div>
        <//>
      </div>
    </div>
  `;
};

const ChatHeader = () => html`
  <div class="chat-header">
    <div class="header-avatar">🤖</div>
    <div class="header-info">
      <div class="header-name">AI 어시스턴트</div>
      <div class="header-status">
        <div class="status-dot"></div>
        온라인
      </div>
    </div>
  </div>
`;

const MessageList = () => {
  // Owned by the component, so the effect is disposed with it. Re-runs on every
  // change to the list — including messages merged in from another instance.
  createEffect(() => {
    messages();
    setTimeout(scrollToBottom, 50);
  });

  return html`
    <div class="messages-container" ref=${(el: HTMLDivElement) => { messagesEl = el; }}>
      <${For} each=${messages}>
        ${(msg: ChatMessage) => html`<${MessageBubble} msg=${msg} />`}
      <//>
    </div>
  `;
};

const InputArea = () => html`
  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        class="chat-textarea"
        placeholder="메시지를 입력하세요! (Enter로 전송, Shift+Enter 줄바꿈)"
        value=${inputValue}
        onInput=${handleInput}
        onKeydown=${handleKeyDown}
        rows="1"
        disabled=${isWaiting}
      ></textarea>
    </div>
    <button class="send-btn" onClick=${sendMessage} disabled=${isWaiting} title="전송">↑</button>
  </div>
`;

const App = () => {
  onMount(() => {
    registerProtocol();
    void initStore().catch((e) => console.error('[ai-chat] store init failed:', errMsg(e)));
    scrollToBottom();
  });

  return html`
    <div class="chat-app">
      <${ChatHeader} />
      <${MessageList} />
      <${InputArea} />
    </div>
  `;
};

render(() => html`<${App} />`, document.getElementById('app')!);
