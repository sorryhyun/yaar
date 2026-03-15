/**
 * Hierarchical context management for agent conversations.
 *
 * Context is the central organizing principle in the new architecture.
 * Messages are tagged with their source URI (monitor or window) to enable:
 * - Window agents to see relevant conversation history
 * - Manual pruning of window-specific context
 * - Clear separation between monitor flow and window branches
 */

const MONITOR_PREFIX = 'yaar://monitors/';
const WINDOW_PREFIX = 'yaar://windows/';

/**
 * URI-based context source addressing.
 * - `yaar://monitors/{monitorId}`: Messages from a monitor's conversation
 * - `yaar://windows/{windowId}`: Messages from a specific window's conversation
 */
export type ContextSource = `yaar://monitors/${string}` | `yaar://windows/${string}`;

export function monitorSource(monitorId: string): ContextSource {
  return `yaar://monitors/${monitorId}`;
}

export function windowSource(windowId: string): ContextSource {
  return `yaar://windows/${windowId}`;
}

export function isMonitorSource(source: ContextSource): source is `yaar://monitors/${string}` {
  return source.startsWith(MONITOR_PREFIX);
}

export function isWindowSource(source: ContextSource): source is `yaar://windows/${string}` {
  return source.startsWith(WINDOW_PREFIX);
}

export function extractWindowId(source: ContextSource): string | null {
  if (!isWindowSource(source)) return null;
  return source.slice(WINDOW_PREFIX.length);
}

export function extractMonitorId(source: ContextSource): string | null {
  if (!isMonitorSource(source)) return null;
  return source.slice(MONITOR_PREFIX.length);
}

/**
 * A message in the context tape.
 */
export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  source: ContextSource;
}

/**
 * Options for filtering messages from the context tape.
 */
export interface GetMessagesOptions {
  /** Include messages from window branches (default: true) */
  includeWindows?: boolean;
  /** Filter to only these specific window IDs */
  windowIds?: string[];
  /** Exclude messages from these window IDs */
  excludeWindowIds?: string[];
}

/**
 * Options for formatting context for prompt injection.
 */
export interface FormatOptions {
  /** Include messages from window branches (default: false for window agents) */
  includeWindows?: boolean;
  /** Only include messages from this specific window (for window-specific context) */
  windowId?: string;
}

/**
 * Maximum number of monitor messages before pruning.
 * Window messages are pruned on window close, so only monitor messages accumulate unbounded.
 */
const MAX_MONITOR_MESSAGES = 200;

/**
 * ContextTape manages the hierarchical conversation history.
 *
 * Messages are stored with their source (monitor or window) and can be:
 * - Retrieved with optional filtering
 * - Pruned by window (manual operation)
 * - Formatted for prompt injection
 *
 * A sliding window limits monitor-source messages to prevent unbounded memory growth.
 */
export class ContextTape {
  private messages: ContextMessage[] = [];

  /**
   * Append a message to the context tape.
   * Automatically prunes oldest monitor messages when the limit is exceeded.
   */
  append(role: 'user' | 'assistant', content: string, source: ContextSource): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      source,
    });

    this.pruneIfNeeded();
  }

  /**
   * Prune oldest monitor messages when the tape exceeds the limit.
   * Preserves window messages (they are pruned separately on window close).
   */
  private pruneIfNeeded(): void {
    const monitorMessages = this.messages.filter((m) => isMonitorSource(m.source));
    if (monitorMessages.length <= MAX_MONITOR_MESSAGES) return;

    // Remove the oldest monitor messages to bring count back to the limit.
    // We keep the most recent half to preserve context continuity.
    const keepCount = Math.floor(MAX_MONITOR_MESSAGES / 2);
    const monitorToRemove = new Set(monitorMessages.slice(0, monitorMessages.length - keepCount));
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !monitorToRemove.has(m));
    console.log(
      `[ContextTape] Pruned ${before - this.messages.length} oldest monitor messages (${this.messages.length} remaining)`,
    );
  }

  /**
   * Get messages from the context tape with optional filtering.
   */
  getMessages(options?: GetMessagesOptions): ContextMessage[] {
    const { includeWindows = true, windowIds, excludeWindowIds } = options ?? {};

    return this.messages.filter((msg) => {
      if (!isWindowSource(msg.source)) return true;

      if (!includeWindows) return false;

      const wid = extractWindowId(msg.source)!;

      if (windowIds && !windowIds.includes(wid)) return false;
      if (excludeWindowIds && excludeWindowIds.includes(wid)) return false;

      return true;
    });
  }

  /**
   * Get all messages (unfiltered).
   */
  getAllMessages(): ContextMessage[] {
    return [...this.messages];
  }

  /**
   * Prune all messages from a specific window branch.
   * Returns the pruned messages for logging/debugging.
   *
   * Note: This is a manual operation, not triggered automatically on window close.
   */
  pruneWindow(windowId: string): ContextMessage[] {
    const target = windowSource(windowId);
    const pruned: ContextMessage[] = [];
    this.messages = this.messages.filter((msg) => {
      if (msg.source === target) {
        pruned.push(msg);
        return false;
      }
      return true;
    });
    return pruned;
  }

  /**
   * Format messages for injection into agent prompts.
   *
   * For monitor agents: Include only monitor conversation (default)
   * For window agents: Include monitor + optionally their own window history
   */
  formatForPrompt(options?: FormatOptions): string {
    const { includeWindows = false, windowId } = options ?? {};

    const filtered = this.messages.filter((msg) => {
      if (!isWindowSource(msg.source)) return true;
      if (!includeWindows) return false;
      if (windowId) return extractWindowId(msg.source) === windowId;
      return true;
    });

    if (filtered.length === 0) {
      return '';
    }

    const formatted = filtered
      .map((m) => {
        const wid = extractWindowId(m.source);
        const tag = wid ? `${m.role}:${wid}` : m.role;
        return `<${tag}>${m.content}</${tag}>`;
      })
      .join('\n\n');

    return `<previous_conversation>\n${formatted}\n</previous_conversation>\n\n`;
  }

  /**
   * Get the number of messages in the tape.
   */
  get length(): number {
    return this.messages.length;
  }

  /**
   * Restore messages from a previous session.
   * Preserves original ordering, timestamps, and branch identity.
   */
  restore(messages: ContextMessage[]): void {
    this.messages = [...messages, ...this.messages];
  }

  /**
   * Clear all messages from the tape.
   */
  clear(): void {
    this.messages = [];
  }
}
