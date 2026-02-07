/**
 * CallbackQueue - accumulates structured summaries from ephemeral and window agents.
 *
 * Non-main agents push callbacks when they complete work. The main agent drains
 * the queue on its next turn so it knows what happened in parallel.
 */

import type { OSAction } from '@yaar/shared';

/**
 * A structured summary of what an agent did.
 */
export interface AgentCallback {
  /** Agent role identifier, e.g. 'ephemeral-1' or 'window-settings' */
  role: string;
  /** Truncated description of the task the agent handled */
  task: string;
  /** OS actions the agent executed */
  actions: OSAction[];
  /** Window ID if this was a window agent */
  windowId?: string;
  /** When the callback was created */
  timestamp: number;
}

/**
 * Accumulates agent callbacks and formats them for injection into the main agent's prompt.
 */
export class CallbackQueue {
  private queue: AgentCallback[] = [];

  /**
   * Push a callback from a completed agent task.
   */
  push(cb: AgentCallback): void {
    this.queue.push(cb);
  }

  /**
   * Drain all callbacks, returning them and clearing the queue.
   */
  drain(): AgentCallback[] {
    const items = this.queue;
    this.queue = [];
    return items;
  }

  /**
   * Format all pending callbacks as an XML block for prompt injection.
   * Returns empty string if no callbacks are pending.
   */
  format(): string {
    if (this.queue.length === 0) return '';

    const entries = this.queue.map((cb) => {
      const attrs = [
        `agent="${cb.role}"`,
        `task="${cb.task}"`,
      ];
      if (cb.windowId) attrs.push(`window="${cb.windowId}"`);

      const summary = this.summarizeActions(cb.actions, cb.windowId);
      return `<callback ${attrs.join(' ')}>\n  ${summary}\n</callback>`;
    });

    return `<agent_callbacks>\n${entries.join('\n')}\n</agent_callbacks>\n\n`;
  }

  /**
   * Number of pending callbacks.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Clear all pending callbacks without returning them.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Summarize a list of OS actions into a human-readable string.
   */
  private summarizeActions(actions: OSAction[], _windowId?: string): string {
    if (actions.length === 0) return 'No actions taken.';

    const parts: string[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'window.create':
          parts.push(`Created window "${action.windowId}" (${action.content?.renderer ?? 'unknown'}).`);
          break;
        case 'window.close':
          parts.push(`Closed window "${action.windowId}".`);
          break;
        case 'window.setTitle':
          parts.push(`Set title of "${action.windowId}" to "${action.title}".`);
          break;
        case 'window.setContent':
          parts.push(`Updated content of "${action.windowId}".`);
          break;
        case 'window.updateContent':
          parts.push(`Modified content of "${action.windowId}" (${(action.operation as { op: string }).op}).`);
          break;
        case 'notification.show':
          parts.push(`Showed notification: "${action.title}".`);
          break;
        case 'notification.dismiss':
          parts.push(`Dismissed notification "${action.id}".`);
          break;
        default:
          parts.push(`Action: ${action.type}.`);
          break;
      }
    }

    return parts.join(' ');
  }
}
