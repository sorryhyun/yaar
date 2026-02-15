import type { UserInteraction } from '@yaar/shared';
import type { ContextTape, ContextSource } from '../context.js';
import type { InteractionTimeline } from '../interaction-timeline.js';

export interface MainPromptContext {
  prompt: string;
  contextContent: string;
}

export class ContextAssemblyPolicy {
  private readonly windowInitialMaxTurns: number;

  constructor(windowInitialMaxTurns = 5) {
    this.windowInitialMaxTurns = windowInitialMaxTurns;
  }

  formatOpenWindows(windowIds: string[]): string {
    if (windowIds.length === 0) return '';
    return `<open_windows>${windowIds.join(', ')}</open_windows>\n\n`;
  }

  /**
   * Build main agent prompt, draining and injecting timeline from parallel agents and user interactions.
   */
  buildMainPrompt(
    content: string,
    options: {
      interactions?: UserInteraction[];
      openWindows: string;
      reloadPrefix: string;
      timeline?: InteractionTimeline;
    },
  ): MainPromptContext {
    // Add drawing as timeline entry if present
    const hasDrawing = options.interactions?.some((i) => i.type === 'draw' && i.imageData);

    // Format timeline (includes both user interactions and AI callbacks)
    let timelinePrefix = options.timeline?.format() ?? '';
    // Drain the timeline after formatting
    if (options.timeline && options.timeline.size > 0) {
      options.timeline.drain();
    }

    // Add drawing annotation after timeline
    if (hasDrawing) {
      timelinePrefix += '<interaction:user>draw [image attached]</interaction:user>\n\n';
    }

    return {
      prompt: timelinePrefix + options.openWindows + options.reloadPrefix + content,
      contextContent: content,
    };
  }

  /**
   * Build prompt for window agent interactions (subsequent turns, session continuity).
   * No contextPrefix — window agents maintain their own provider session.
   */
  buildWindowPrompt(
    content: string,
    options: {
      openWindows: string;
      reloadPrefix: string;
    },
  ): string {
    return options.openWindows + options.reloadPrefix + content;
  }

  /**
   * Build initial context for a new window agent.
   * Includes the last N main conversation turns so the window agent has context
   * about what the user and main agent have been discussing.
   */
  buildWindowInitialContext(
    tape: ContextTape,
    maxTurns: number = this.windowInitialMaxTurns,
  ): string {
    const mainMessages = tape.getMessages({ includeWindows: false });
    if (mainMessages.length === 0) return '';

    // Take the last N turns (each turn = user + assistant pair)
    const recent = mainMessages.slice(-maxTurns * 2);
    if (recent.length === 0) return '';

    const formatted = recent
      .map((m) => {
        return `<${m.role}>${m.content}</${m.role}>`;
      })
      .join('\n\n');

    return `<recent_conversation>\n${formatted}\n</recent_conversation>\n\n`;
  }

  appendUserMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('user', content, source);
  }

  appendAssistantMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('assistant', content, source);
  }
}
