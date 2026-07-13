import { createSignal } from '@bundled/solid-js';
import { appStorage } from '@bundled/yaar';
import type { ChatMessage, PersistedState } from './types';
import { TYPING_INDICATOR_ID } from './types';
import { makeMessage } from './helpers';

const STORE_PATH = 'chat.json';
/** How often to re-read conversation state written by another instance. */
const SYNC_MS = 1500;

const WELCOME = makeMessage(
  'assistant',
  '안녕하세요! 저는 AI 어시스턴트입니다. 무엇이든 물어보세요 😊',
  'done',
  'welcome',
);

export const [messages, setMessages] = createSignal<ChatMessage[]>([WELCOME]);
export const [isWaiting, setIsWaiting] = createSignal(false);
export const [inputValue, setInputValue] = createSignal('');

/**
 * Turn ids that have already produced a displayed assistant reply.
 *
 * Persisted rather than kept purely in memory: a duplicate emit for a turn can
 * land on a *different* instance of the app than the one that answered it, and
 * an in-memory-only set cannot dedupe across instances. Persisting makes the
 * "at most one reply per user turn" guarantee hold app-wide, not tab-locally.
 */
const answeredTurns = new Set<string>();

// ── Shared state ──────────────────────────────────────────────────────────
//
// Every message is written to app storage, and every instance polls storage and
// merges in anything it does not already have.
//
// This is what keeps the *visible* window truthful. Protocol commands are
// delivered to one registered instance; when more than one instance is live,
// the instance the agent talks to is not necessarily the one the user is
// looking at. That divergence is what made the chat look empty while app_query
// still reported messages. Sharing state through storage removes it — and gives
// us conversation history across reloads for free.

let lastWritten = '';
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Messages worth persisting — the typing placeholder is transient UI, not history. */
function durable(list: ChatMessage[]): ChatMessage[] {
  return list.filter((m) => m.id !== TYPING_INDICATOR_ID && m.status !== 'loading');
}

async function persistNow(): Promise<void> {
  const payload: PersistedState = {
    messages: durable(messages()),
    answeredTurns: [...answeredTurns],
  };
  const json = JSON.stringify(payload);
  // Skip no-op writes so polling instances don't ping-pong writes at each other.
  if (json === lastWritten) return;
  lastWritten = json;
  await appStorage.trySave(STORE_PATH, json, { label: 'chat history' });
}

/** Debounced persist — a burst of updates collapses into one write. */
export function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistNow();
  }, 250);
}

/** Fold state written by another instance into this one. Id-keyed, so idempotent. */
function mergeRemote(remote: PersistedState): void {
  for (const t of remote.answeredTurns ?? []) answeredTurns.add(t);

  const incomingAll = remote.messages ?? [];
  if (!incomingAll.length) return;

  setMessages((prev) => {
    const known = new Set(prev.map((m) => m.id));
    const incoming = incomingAll.filter((m) => !known.has(m.id));
    if (!incoming.length) return prev;

    // Another instance answered the turn we are waiting on — retire our spinner.
    const answered = incoming.some(
      (m) => m.role === 'assistant' && (m.status === 'done' || m.status === 'error'),
    );
    if (answered) setIsWaiting(false);

    const settled = prev
      .filter((m) => m.id !== TYPING_INDICATOR_ID)
      .concat(incoming)
      .sort((a, b) => a.timestamp - b.timestamp);

    const typing = answered ? [] : prev.filter((m) => m.id === TYPING_INDICATOR_ID);
    return [...settled, ...typing];
  });
}

/**
 * Guarded: storage being unavailable must degrade to a working in-memory chat,
 * never to a broken one. Each tick swallows its own failure so one bad read
 * cannot tear down the polling loop.
 */
async function syncFromStorage(): Promise<void> {
  try {
    const stored = await appStorage.readJsonOr<PersistedState | null>(STORE_PATH, null);
    if (stored && Array.isArray(stored.messages)) mergeRemote(stored);
  } catch {
    /* storage unavailable — keep running on in-memory state */
  }
}

/**
 * Load shared conversation state, then keep polling for changes made by other
 * instances. Called once from onMount.
 */
export async function initStore(): Promise<void> {
  await syncFromStorage();
  // The interval starts unconditionally: if the very first write fails we still
  // want to recover as soon as storage becomes available.
  setInterval(() => {
    void syncFromStorage();
  }, SYNC_MS);
  await persistNow();
}

// ── Turn resolution ────────────────────────────────────────────────────

/**
 * Record a user message and return its turn id. The id is what the agent must
 * echo back as `replyTo`, and it is what makes the reply idempotent.
 */
export function beginTurn(text: string, msgId: string): void {
  setMessages((prev) => [
    ...prev,
    makeMessage('user', text, 'sent', msgId),
    makeMessage('assistant', '', 'loading', TYPING_INDICATOR_ID),
  ]);
  setIsWaiting(true);
  setInputValue('');
  schedulePersist();
}

/**
 * Remove the typing placeholder and append the finished assistant message in one
 * atomic update, then clear the waiting flag.
 *
 * The single authoritative path for resolving an AI turn — both the success
 * (addMessage) and error (setError) protocol handlers go through it.
 *
 * De-duplication, in order:
 *   1. Turn-based — only the FIRST reply for a given `turnId` is displayed, so a
 *      retry or a trailing "done." is dropped no matter how late it arrives, or
 *      which instance it arrives at (answeredTurns is shared via storage).
 *   2. Id-based — a message whose id is already on screen is a plain duplicate.
 *
 * Messages carrying no turn id are always displayed: that covers unsolicited /
 * manual emits, and must not be swallowed.
 */
export function finishWithMessage(msg: ChatMessage, turnId?: string): void {
  // Always re-enable the UI, even when the message itself is dropped.
  setIsWaiting(false);

  if (turnId) {
    if (answeredTurns.has(turnId)) {
      // Duplicate reply for a turn we already answered — drop it, but make sure
      // the placeholder cannot survive as a permanent spinner.
      setMessages((prev) => prev.filter((m) => m.id !== TYPING_INDICATOR_ID));
      return;
    }
    answeredTurns.add(turnId);
  }

  if (msg.id && messages().some((m) => m.id === msg.id && m.id !== TYPING_INDICATOR_ID)) {
    setMessages((prev) => prev.filter((m) => m.id !== TYPING_INDICATOR_ID));
    return;
  }

  setMessages((prev) => [...prev.filter((m) => m.id !== TYPING_INDICATOR_ID), msg]);
  schedulePersist();
}

/** True when this turn already has a displayed reply. Lets the protocol layer
 *  tell the agent "already answered" instead of silently accepting a retry. */
export function isTurnAnswered(turnId: string): boolean {
  return answeredTurns.has(turnId);
}
