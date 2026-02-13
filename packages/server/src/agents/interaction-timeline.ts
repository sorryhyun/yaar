/**
 * InteractionTimeline - unified timeline of user interactions and AI agent actions.
 *
 * Replaces CallbackQueue with a chronological timeline that interleaves
 * user-originated events (close, focus, move, resize) with AI agent summaries.
 * The main agent drains the timeline on its next turn to see everything that happened.
 */

import type { OSAction, UserInteraction } from '@yaar/shared';
import { formatCompactInteraction } from '@yaar/shared';

interface TimelineEntry {
  type: 'user' | 'AI';
  content: string;
  agent?: string;
  timestamp: number;
}

export class InteractionTimeline {
  private entries: TimelineEntry[] = [];

  /**
   * Push a user interaction into the timeline.
   * Deduplicates redundant interactions:
   * - Consecutive focus on the same window is collapsed
   * - Focus immediately before move/resize on the same window is removed
   */
  pushUser(interaction: UserInteraction): void {
    const content = formatCompactInteraction(interaction);
    const windowId = interaction.windowId;
    const verb = interaction.type.split('.')[1]; // 'close', 'focus', 'move', etc.

    if (windowId && this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];

      // Skip duplicate consecutive focus on the same window
      if (verb === 'focus' && last.type === 'user' && last.content === content) {
        return;
      }

      // Move/resize implies focus — remove preceding focus on the same window
      if (
        (verb === 'move' || verb === 'resize') &&
        last.type === 'user' &&
        last.content === `focus:${windowId}`
      ) {
        this.entries.pop();
      }
    }

    this.entries.push({
      type: 'user',
      content,
      timestamp: interaction.timestamp,
    });
  }

  /**
   * Push an AI agent action summary into the timeline.
   */
  pushAI(role: string, task: string, actions: OSAction[], windowId?: string): void {
    const summary = this.summarizeActions(actions, windowId);
    this.entries.push({
      type: 'AI',
      content: summary,
      agent: role,
      timestamp: Date.now(),
    });
  }

  /**
   * Format all pending entries as an XML block for prompt injection.
   * Returns empty string if no entries are pending.
   */
  format(): string {
    if (this.entries.length === 0) return '';

    const lines = this.entries.map((e) => {
      if (e.type === 'user') {
        return `<interaction:user>${e.content}</interaction:user>`;
      }
      const agentAttr = e.agent ? ` agent="${e.agent}"` : '';
      return `<interaction:AI${agentAttr}>${e.content}</interaction:AI>`;
    });

    return `<timeline>\n${lines.join('\n')}\n</timeline>\n\n`;
  }

  /**
   * Drain all entries, returning them and clearing the timeline.
   */
  drain(): TimelineEntry[] {
    const items = this.entries;
    this.entries = [];
    return items;
  }

  /**
   * Number of pending entries.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Clear all pending entries without returning them.
   */
  clear(): void {
    this.entries = [];
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
          parts.push(
            `Created window "${action.windowId}" (${action.content?.renderer ?? 'unknown'}).`,
          );
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
          parts.push(
            `Modified content of "${action.windowId}" (${(action.operation as { op: string }).op}).`,
          );
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
