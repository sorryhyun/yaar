import type { ParsedMessage } from './types.js';
import {
  type ContextMessage,
  type ContextSource,
  monitorSource,
  windowSource,
  extractWindowId,
} from '../agents/context.js';

export interface ContextRestorePolicy {
  mode: 'full' | 'monitor_and_selected_windows' | 'summarize_old_windows';
  selectedWindowIds?: string[];
  activeWindowIds?: string[];
  summaryTextByWindow?: Record<string, string>;
}

export const FULL_RESTORE_POLICY: ContextRestorePolicy = {
  mode: 'full',
};

function toContextMessage(msg: ParsedMessage): ContextMessage | null {
  if ((msg.type !== 'user' && msg.type !== 'assistant') || !msg.content) {
    return null;
  }

  const source: ContextSource =
    typeof msg.source === 'string' && msg.source.startsWith('yaar://')
      ? (msg.source as ContextSource)
      : monitorSource('0');

  return {
    role: msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
    source,
  };
}

function sourceWindowId(msg: ContextMessage): string | null {
  return extractWindowId(msg.source);
}

/**
 * Extract context tape messages from parsed session logs with policy-based filtering.
 */
export function getContextRestoreMessages(
  messages: ParsedMessage[],
  policy: ContextRestorePolicy = FULL_RESTORE_POLICY,
): ContextMessage[] {
  const parsed = messages
    .map(toContextMessage)
    .filter((msg): msg is ContextMessage => msg !== null);

  if (policy.mode === 'full') {
    return parsed;
  }

  if (policy.mode === 'monitor_and_selected_windows') {
    const selected = new Set(policy.selectedWindowIds ?? []);
    return parsed.filter((msg) => {
      const windowId = sourceWindowId(msg);
      return windowId === null || selected.has(windowId);
    });
  }

  const active = new Set(policy.activeWindowIds ?? []);
  const summaryTextByWindow = policy.summaryTextByWindow ?? {};
  const result = parsed.filter((msg) => {
    const windowId = sourceWindowId(msg);
    return windowId === null || active.has(windowId);
  });

  const windowLastTimestamp = new Map<string, string>();
  for (const msg of parsed) {
    const windowId = sourceWindowId(msg);
    if (windowId) {
      windowLastTimestamp.set(windowId, msg.timestamp);
    }
  }

  const sortedOldWindowIds = [...windowLastTimestamp.keys()]
    .filter((windowId) => !active.has(windowId))
    .sort((a, b) => windowLastTimestamp.get(a)!.localeCompare(windowLastTimestamp.get(b)!));

  for (const windowId of sortedOldWindowIds) {
    const timestamp = windowLastTimestamp.get(windowId)!;
    const summary =
      summaryTextByWindow[windowId] ?? `Older window branch ${windowId} omitted during restore.`;
    result.push({
      role: 'assistant',
      content: `[window_summary:${windowId}] ${summary}`,
      timestamp,
      source: windowSource(windowId),
    });
  }

  return result;
}
