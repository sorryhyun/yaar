export {};
import { createEffect, For, Show, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { v4 as uuid } from '@bundled/uuid';
import { app } from '@bundled/yaar';
import './styles.css';
import { messages, setMessages, isWaiting, setIsWaiting, inputValue, setInputValue } from './store';
import { registerProtocol } from './protocol';
import { makeMessage, formatTime } from './helpers';
import { TYPING_INDICATOR_ID } from './types';
import type { ChatMessage } from './types';

// ── Scroll helper ──

let messagesEl: HTMLDivElement | undefined;

function scrollToBottom() {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

createEffect(() => {
  messages(); // track signal so effect re-runs on every new message
  setTimeout(scrollToBottom, 50);
});

// ── Message actions ──

function sendMessage() {
  const text = inputValue().trim();
  if (!text || isWaiting()) return;

  const msgId = uuid();

  setMessages(prev => [
    ...prev,
    makeMessage('user', text, 'sent', msgId),
    makeMessage('assistant', '', 'loading', TYPING_INDICATOR_ID),
  ]);
  setIsWaiting(true);
  setInputValue('');

  // Notify the agent via the App Protocol
  app?.sendInteraction({
    event: 'user_message',
    content: text,
    msgId,
    instructions:
      'Reply to the user message above. Use app_command addMessage to display your response in this chat window.',
  });
}

// ── Input handlers ──

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function handleInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  setInputValue(ta.value);
  // Auto-grow textarea up to max-height defined in CSS
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ── Components ──

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
      <div>
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

const MessageList = () => html`
  <div class="messages-container" ref=${(el: HTMLDivElement) => { messagesEl = el; }}>
    <${For} each=${messages}>
      ${(msg: ChatMessage) => html`<${MessageBubble} msg=${msg} />`}
    <//>
  </div>
`;

const InputArea = () => html`
  <div class="input-area">
    <div class="input-wrapper">
      <textarea
        class="chat-textarea"
        placeholder="메시지를 입력하세요...! (Enter로 전송, Shift+Enter 줄바꿈)"
        value=${inputValue}
        onInput=${handleInput}
        onKeydown=${handleKeyDown}
        rows="1"
        disabled=${isWaiting}
      ></textarea>
    </div>
    <button
      class="send-btn"
      onClick=${sendMessage}
      disabled=${isWaiting}
      title="전송"
    >↑</button>
  </div>
`;

const App = () => html`
  <div class="chat-app">
    <${ChatHeader} />
    <${MessageList} />
    <${InputArea} />
  </div>
`;

// ── Bootstrap ──

onMount(() => {
  registerProtocol();
  scrollToBottom();
});

render(() => html`<${App} />`, document.getElementById('app')!);
