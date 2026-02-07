import type { UserInteraction } from '@yaar/shared';
import type { ContextTape, ContextSource } from '../context.js';
import type { CallbackQueue } from '../callback-queue.js';

export interface MainPromptContext {
  prompt: string;
  contextContent: string;
}

export class ContextAssemblyPolicy {
  formatInteractionsForContext(interactions: UserInteraction[]): string {
    if (interactions.length === 0) return '';

    const drawings = interactions.filter(i => i.type === 'draw' && i.imageData);
    const otherInteractions = interactions.filter(i => i.type !== 'draw');

    const parts: string[] = [];

    if (otherInteractions.length > 0) {
      const lines = otherInteractions.map(i => {
        let content = '';
        if (i.windowTitle) content += `"${i.windowTitle}"`;
        if (i.details) content += content ? ` (${i.details})` : i.details;
        return `<user_interaction:${i.type}>${content}</user_interaction:${i.type}>`;
      });
      parts.push(`<previous_interactions>\n${lines.join('\n')}\n</previous_interactions>`);
    }

    if (drawings.length > 0) {
      parts.push(`<user_interaction:draw>[User drawing attached as image]</user_interaction:draw>`);
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  }

  formatOpenWindows(windowIds: string[]): string {
    if (windowIds.length === 0) return '';
    return `<open_windows>${windowIds.join(', ')}</open_windows>\n\n`;
  }

  /**
   * Build main agent prompt, draining and injecting callbacks from parallel agents.
   */
  buildMainPrompt(content: string, options: {
    interactions?: UserInteraction[];
    openWindows: string;
    reloadPrefix: string;
    callbackQueue?: CallbackQueue;
  }): MainPromptContext {
    const interactionPrefix = options.interactions?.length
      ? this.formatInteractionsForContext(options.interactions)
      : '';

    // Drain callbacks from parallel agents and inject as prefix
    const callbackPrefix = options.callbackQueue?.format() ?? '';
    // Drain the queue after formatting so main agent consumes them
    if (options.callbackQueue && options.callbackQueue.size > 0) {
      options.callbackQueue.drain();
    }

    return {
      prompt: callbackPrefix + options.openWindows + options.reloadPrefix + content,
      contextContent: interactionPrefix + content,
    };
  }

  /**
   * Build prompt for window agent interactions (subsequent turns, session continuity).
   * No contextPrefix — window agents maintain their own provider session.
   */
  buildWindowPrompt(content: string, options: {
    openWindows: string;
    reloadPrefix: string;
  }): string {
    return options.openWindows + options.reloadPrefix + content;
  }

  /**
   * Build initial context for a new window agent.
   * Includes the last N main conversation turns so the window agent has context
   * about what the user and main agent have been discussing.
   */
  buildWindowInitialContext(tape: ContextTape, maxTurns: number = 3): string {
    const mainMessages = tape.getMessages({ includeWindows: false });
    if (mainMessages.length === 0) return '';

    // Take the last N turns (each turn = user + assistant pair)
    const recent = mainMessages.slice(-maxTurns * 2);
    if (recent.length === 0) return '';

    const formatted = recent.map((m) => {
      return `<${m.role}>${m.content}</${m.role}>`;
    }).join('\n\n');

    return `<recent_conversation>\n${formatted}\n</recent_conversation>\n\n`;
  }

  appendUserMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('user', content, source);
  }

  appendAssistantMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('assistant', content, source);
  }
}
