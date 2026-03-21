export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'sent' | 'loading' | 'done' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: number;
}

/** Sentinel ID for the typing-indicator placeholder message */
export const TYPING_INDICATOR_ID = 'typing-indicator';
