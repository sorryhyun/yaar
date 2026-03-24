import { createSignal } from '@bundled/solid-js';
import type { ChatMessage } from './types';
import { TYPING_INDICATOR_ID } from './types';
import { makeMessage } from './helpers';

export const [messages, setMessages] = createSignal<ChatMessage[]>([
  makeMessage('assistant', '안녕하세요! 저는 AI 어시스턴트입니다. 무엇이든 물어보세요 😊', 'done', 'welcome'),
]);
export const [isWaiting, setIsWaiting] = createSignal(false);
export const [inputValue, setInputValue] = createSignal('');

/**
 * Remove the typing-indicator placeholder and append the finished assistant
 * message in one atomic update, then clear the waiting flag.
 *
 * This is the single authoritative path for resolving an AI turn — both
 * the success (addMessage) and error (setError) protocol handlers use it.
 */
export function finishWithMessage(msg: ChatMessage): void {
  setMessages(prev => [...prev.filter(m => m.id !== TYPING_INDICATOR_ID), msg]);
  setIsWaiting(false);
}
