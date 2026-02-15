/**
 * Hierarchical context management for agent conversations.
 *
 * Context is the central organizing principle in the new architecture.
 * Messages are tagged with their source (main conversation or specific window)
 * to enable:
 * - Window agents to see relevant conversation history
 * - Manual pruning of window-specific context
 * - Clear separation between main flow and window branches
 */

/**
 * The source of a context message.
 * - 'main': Messages from the main conversation flow
 * - { window: string }: Messages from a specific window's conversation
 */
export type ContextSource = 'main' | { window: string };

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
 * Maximum number of main messages before pruning.
 * Window messages are pruned on window close, so only main messages accumulate unbounded.
 */
const MAX_MAIN_MESSAGES = 200;

/**
 * ContextTape manages the hierarchical conversation history.
 *
 * Messages are stored with their source (main or window) and can be:
 * - Retrieved with optional filtering
 * - Pruned by window (manual operation)
 * - Formatted for prompt injection
 *
 * A sliding window limits main-source messages to prevent unbounded memory growth.
 */
export class ContextTape {
  private messages: ContextMessage[] = [];

  /**
   * Append a message to the context tape.
   * Automatically prunes oldest main messages when the limit is exceeded.
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
   * Prune oldest main messages when the tape exceeds the limit.
   * Preserves window messages (they are pruned separately on window close).
   */
  private pruneIfNeeded(): void {
    const mainMessages = this.messages.filter((m) => m.source === 'main');
    if (mainMessages.length <= MAX_MAIN_MESSAGES) return;

    // Remove the oldest main messages to bring count back to the limit.
    // We keep the most recent half to preserve context continuity.
    const keepCount = Math.floor(MAX_MAIN_MESSAGES / 2);
    const mainToRemove = new Set(mainMessages.slice(0, mainMessages.length - keepCount));
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !mainToRemove.has(m));
    console.log(
      `[ContextTape] Pruned ${before - this.messages.length} oldest main messages (${this.messages.length} remaining)`,
    );
  }

  /**
   * Get messages from the context tape with optional filtering.
   */
  getMessages(options?: GetMessagesOptions): ContextMessage[] {
    const { includeWindows = true, windowIds, excludeWindowIds } = options ?? {};

    return this.messages.filter((msg) => {
      // Check if this is a window message
      const isWindowMessage = typeof msg.source === 'object' && 'window' in msg.source;

      if (!includeWindows && isWindowMessage) {
        return false;
      }

      if (isWindowMessage) {
        const windowId = (msg.source as { window: string }).window;

        // Filter by specific window IDs if provided
        if (windowIds && !windowIds.includes(windowId)) {
          return false;
        }

        // Exclude specific window IDs if provided
        if (excludeWindowIds && excludeWindowIds.includes(windowId)) {
          return false;
        }
      }

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
    const pruned: ContextMessage[] = [];
    this.messages = this.messages.filter((msg) => {
      if (typeof msg.source === 'object' && msg.source.window === windowId) {
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
   * For main agents: Include only main conversation (default)
   * For window agents: Include main + optionally their own window history
   */
  formatForPrompt(options?: FormatOptions): string {
    const { includeWindows = false, windowId } = options ?? {};

    const filtered = this.messages.filter((msg) => {
      const isWindowMessage = typeof msg.source === 'object' && 'window' in msg.source;

      if (!isWindowMessage) {
        // Always include main messages
        return true;
      }

      if (!includeWindows) {
        return false;
      }

      // If a specific window is requested, only include that window's messages
      if (windowId) {
        return (msg.source as { window: string }).window === windowId;
      }

      return true;
    });

    if (filtered.length === 0) {
      return '';
    }

    const formatted = filtered
      .map((m) => {
        const tag = typeof m.source === 'object' ? `${m.role}:${m.source.window}` : m.role;
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
