export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'sent' | 'loading' | 'done' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: number;
}

/** Shape of the shared conversation state written to app storage. */
export interface PersistedState {
  messages: ChatMessage[];
  answeredTurns: string[];
  /**
   * Monotonic generation stamp, bumped on every reset. Because the cross-instance
   * merge is add-only (it can grow the message set but never shrink it), a clear
   * cannot be expressed as "fewer messages" — a stale poll would just re-add them.
   * A newer `clearedAt` marks an authoritative snapshot that *supersedes* older
   * state wholesale, which is how a reset propagates as a real deletion.
   * Optional for backward compatibility with pre-reset persisted files.
   */
  clearedAt?: number;
}

/** Sentinel ID for the typing-indicator placeholder message */
export const TYPING_INDICATOR_ID = 'typing-indicator';
