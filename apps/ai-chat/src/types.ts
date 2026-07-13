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
}

/** Sentinel ID for the typing-indicator placeholder message */
export const TYPING_INDICATOR_ID = 'typing-indicator';
