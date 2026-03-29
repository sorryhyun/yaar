import type { UserInteraction, WindowState } from '@yaar/shared';
import type { ContextTape, ContextSource } from '../context.js';
import type { InteractionTimeline } from '../interaction-timeline.js';

export interface MonitorPromptContext {
  prompt: string;
  contextContent: string;
}

export class ContextAssemblyPolicy {
  private readonly windowInitialMaxTurns: number;

  constructor(windowInitialMaxTurns = 5) {
    this.windowInitialMaxTurns = windowInitialMaxTurns;
  }

  formatOpenWindows(
    windows: WindowState[],
    options?: {
      monitorId?: string;
      currentWindowId?: string;
      getRawWindowId?: (handle: string) => string;
    },
  ): string {
    if (windows.length === 0) return '';
    const getRaw =
      options?.getRawWindowId ??
      ((id: string) => {
        const slashIdx = id.indexOf('/');
        return slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
      });
    const lines = windows.map((w) => {
      const label = w.title || w.content.renderer;
      const current = options?.currentWindowId === w.id ? ' (you)' : '';
      const rawId = getRaw(w.id);
      return `  yaar://windows/${rawId} — ${label}${current}`;
    });
    const monitor = options?.monitorId ? ` monitor="${options.monitorId}"` : '';
    return `<open_windows${monitor}>\n${lines.join('\n')}\n</open_windows>\n\n`;
  }

  /**
   * Build monitor agent prompt, draining and injecting timeline from parallel agents and user interactions.
   */
  buildMonitorPrompt(
    content: string,
    options: {
      interactions?: UserInteraction[];
      openWindows: string;
      reloadPrefix: string;
      timeline?: InteractionTimeline;
    },
  ): MonitorPromptContext {
    // Add drawing as timeline entry if present
    const hasDrawing = options.interactions?.some((i) => i.type === 'draw' && i.imageData);

    // Atomically format and drain the timeline (prevents race between format and drain)
    let timelinePrefix = options.timeline?.drainAndFormat() ?? '';

    // Add drawing annotation after timeline
    if (hasDrawing) {
      timelinePrefix += '<ui:draw>[image attached]</ui:draw>\n\n';
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
   * Includes the last N monitor conversation turns so the window agent has context
   * about what the user and monitor agent have been discussing.
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
