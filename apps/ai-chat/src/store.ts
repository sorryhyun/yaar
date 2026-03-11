import { createSignal } from '@bundled/solid-js';
import type { ChatMessage } from './types';

export const [messages, setMessages] = createSignal<ChatMessage[]>([
  {
    id: 'welcome',
    role: 'assistant',
    content: '안녕하세요! 저는 AI 어시스턴트입니다. 무엇이든 물어보세요 😊',
    status: 'done',
    timestamp: Date.now(),
  }
]);
export const [isWaiting, setIsWaiting] = createSignal(false);
export const [inputValue, setInputValue] = createSignal('');
