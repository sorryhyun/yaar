import type { ParsedMessage } from './types.js';
import {
  type ContextMessage,
  type ContextSource,
  mainSource,
  windowSource,
  extractWindowId,
} from '../agents/context.js';

export interface ContextRestorePolicy {
  mode: 'full' | 'main_and_selected_windows' | 'summarize_old_windows';
  selectedWindowIds?: string[];
  activeWindowIds?: string[];
  summaryTextByWindow?: Record<string, string>;
}

export const FULL_RESTORE_POLICY: ContextRestorePolicy = {
  mode: 'full',
};

/**
 * Normalize a source value from old or new log formats into a ContextSource URI.
 * Old formats: 'main' or { window: string }
 * New format: 'yaar://monitors/...' or 'yaar://windows/...'
 */
function normalizeSource(raw: unknown): ContextSource {
  if (typeof raw === 'string') {
    if (raw === 'main') return mainSource('0');
    if (raw.startsWith('yaar://')) return raw as ContextSource;
    return mainSource('0');
  }
  if (typeof raw === 'object' && raw !== null && 'window' in raw) {
    return windowSource((raw as { window: string }).window);
  }
  return mainSource('0');
}

function inferWindowSource(agentId: string): ContextSource | null {
  if (!agentId.startsWith('window-')) {
    return null;
  }

  return windowSource(agentId.slice('window-'.length));
}

function toContextMessage(msg: ParsedMessage): ContextMessage | null {
  if ((msg.type !== 'user' && msg.type !== 'assistant') || !msg.content) {
    return null;
  }

  const source = msg.source
    ? normalizeSource(msg.source)
    : (inferWindowSource(msg.agentId) ?? mainSource('0'));

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

  if (policy.mode === 'main_and_selected_windows') {
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
