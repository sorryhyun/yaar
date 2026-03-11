export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'sent' | 'loading' | 'done' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: number;
}
