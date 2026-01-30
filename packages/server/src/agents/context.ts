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
 * ContextTape manages the hierarchical conversation history.
 *
 * Messages are stored with their source (main or window) and can be:
 * - Retrieved with optional filtering
 * - Pruned by window (manual operation)
 * - Formatted for prompt injection
 */
export class ContextTape {
  private messages: ContextMessage[] = [];

  /**
   * Append a message to the context tape.
   */
  append(role: 'user' | 'assistant', content: string, source: ContextSource): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      source,
    });
  }

  /**
   * Get messages from the context tape with optional filtering.
   */
  getMessages(options?: GetMessagesOptions): ContextMessage[] {
    const {
      includeWindows = true,
      windowIds,
      excludeWindowIds,
    } = options ?? {};

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

    const formatted = filtered.map((m) => {
      const sourceLabel = typeof m.source === 'object'
        ? `[${m.role}@${m.source.window}]`
        : `[${m.role}]`;
      return `${sourceLabel}: ${m.content}`;
    }).join('\n\n');

    return `<previous_conversation>\n${formatted}\n</previous_conversation>\n\n`;
  }

  /**
   * Get the number of messages in the tape.
   */
  get length(): number {
    return this.messages.length;
  }

  /**
   * Clear all messages from the tape.
   */
  clear(): void {
    this.messages = [];
  }
}
