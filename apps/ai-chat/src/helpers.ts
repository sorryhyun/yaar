import { v4 as uuid } from '@bundled/uuid';
import type { ChatMessage, MessageRole, MessageStatus } from './types';

/**
 * Format a Unix timestamp as a localized HH:MM string.
 */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Factory for creating a ChatMessage with sensible defaults.
 * - `id` defaults to a new UUID when omitted.
 * - `timestamp` is always set to the current time.
 */
export function makeMessage(
  role: MessageRole,
  content: string,
  status: MessageStatus,
  id?: string,
): ChatMessage {
  return { id: id ?? uuid(), role, content, status, timestamp: Date.now() };
}
