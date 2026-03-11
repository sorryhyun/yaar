import { createSignal, For, Show, onMount, createEffect } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { v4 as uuid } from '@bundled/uuid';
import './styles.css';
import { messages, setMessages, isWaiting, setIsWaiting, inputValue, setInputValue } from './store';
import { registerProtocol } from './protocol';
import type { ChatMessage } from './types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

let messagesEl: HTMLDivElement | undefined;

function scrollToBottom() {
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

createEffect(() => {
  messages(); // track
  setTimeout(scrollToBottom, 50);
});

function sendMessage() {
  const text = inputValue().trim();
  if (!text || isWaiting()) return;

  const msgId = uuid();
  const userMsg: ChatMessage = {
    id: msgId,
    role: 'user',
    content: text,
    status: 'sent',
    timestamp: Date.now(),
  };

  // Add typing indicator
  const typingMsg: ChatMessage = {
    id: 'typing-indicator',
    role: 'assistant',
    content: '',
    status: 'loading',
    timestamp: Date.now(),
  };

  setMessages(prev => [...prev, userMsg, typingMsg]);
  setIsWaiting(true);
  setInputValue('');

  // Notify the agent
  if (window.yaar?.app) {
    window.yaar.app.sendInteraction({ event: 'user_message', content: text, msgId });
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function handleInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  setInputValue(ta.value);
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

const MessageBubble = (props: { msg: ChatMessage }) => {
  const isUser = () => props.msg.role === 'user';
  const isLoading = () => props.msg.status === 'loading';

  return html`
    <div class=${() => `message-row ${isUser() ? 'user' : 'assistant'}`}>
      <div class="message-avatar">${() => isUser() ? '🙂' : '🤖'}</div>
      <div>
        <div class=${() => `message-bubble ${props.msg.status === 'error' ? 'error' : ''}`}>
          <${Show} when=${() => !isLoading()} fallback=${html`
            <div class="typing-indicator">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
            </div>
          `}>
            ${() => props.msg.content}
          </${Show}>
        </div>
        <${Show} when=${() => !isLoading()}>
          <div class="message-time">${() => formatTime(props.msg.timestamp)}</div>
        </${Show}>
      </div>
    </div>
  `;
};

const App = () => {
  return html`
    <div class="chat-app">
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

      <div class="messages-container" ref=${(el: HTMLDivElement) => { messagesEl = el; }}>
        <${For} each=${messages}>
          ${(msg: ChatMessage) => html`<${MessageBubble} msg=${msg} />`}
        </${For}>
      </div>

      <div class="input-area">
        <div class="input-wrapper">
          <textarea
            class="chat-textarea"
            placeholder="메시지를 입력하세요... (Enter로 전송, Shift+Enter 줄바꾸음)"
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
        >
          ↑
        </button>
      </div>
    </div>
  `;
};

onMount(() => {
  registerProtocol();
  scrollToBottom();
});

render(() => html`<${App} />`, document.getElementById('app')!);
