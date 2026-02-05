import type { UserInteraction } from '@yaar/shared';
import type { ContextTape, ContextSource } from '../context.js';

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

  buildMainPrompt(content: string, options: { interactions?: UserInteraction[]; openWindows: string; reloadPrefix: string }): MainPromptContext {
    const interactionPrefix = options.interactions?.length
      ? this.formatInteractionsForContext(options.interactions)
      : '';
    return {
      prompt: options.openWindows + options.reloadPrefix + content,
      contextContent: interactionPrefix + content,
    };
  }

  buildWindowPrompt(content: string, options: { openWindows: string; reloadPrefix: string; contextPrefix: string }): string {
    return options.openWindows + options.reloadPrefix + options.contextPrefix + content;
  }

  appendUserMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('user', content, source);
  }

  appendAssistantMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('assistant', content, source);
  }
}
