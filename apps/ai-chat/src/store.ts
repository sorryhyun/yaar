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
 * Turn ids that have already produced a displayed assistant reply.
 * Used for timing-independent de-duplication (see finishWithMessage).
 */
const answeredTurns = new Set<string>();

/**
 * Remove the typing-indicator placeholder and append the finished assistant
 * message in one atomic update, then clear the waiting flag.
 *
 * This is the single authoritative path for resolving an AI turn — both the
 * success (addMessage) and error (setError) protocol handlers use it.
 *
 * De-duplication strategy (timing-independent, decoupled from `isWaiting`):
 *
 *   1. **Turn-based** — each user message carries a `msgId`; the agent echoes
 *      it back as `replyTo`, which becomes `turnId` here. Only the FIRST
 *      message for a given turn is displayed; any repeated / trailing emit for
 *      the same turn (e.g. a stray "done.") is dropped. This kills the
 *      response-loop reliably no matter how far apart the emits arrive.
 *
 *   2. **Id-based** — a message whose id is already on screen is a plain
 *      duplicate and is ignored.
 *
 * Messages that carry NO turn id (manual / unsolicited emits, and the very
 * first response of a turn) are always displayed — this is what fixes the
 * earlier regression where legitimate first responses were being swallowed.
 */
export function finishWithMessage(msg: ChatMessage, turnId?: string): void {
  // Always re-enable the UI, even if we end up dropping a duplicate.
  setIsWaiting(false);

  // (1) Turn-based idempotency: at most one reply per user turn.
  if (turnId) {
    if (answeredTurns.has(turnId)) return;
    answeredTurns.add(turnId);
  }

  // (2) Id-based idempotency: never render the same message id twice.
  if (msg.id && messages().some(m => m.id === msg.id && m.id !== TYPING_INDICATOR_ID)) {
    return;
  }

  setMessages(prev => [...prev.filter(m => m.id !== TYPING_INDICATOR_ID), msg]);
}
