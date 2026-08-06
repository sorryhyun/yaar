import type { UserInteraction, WindowBounds, WindowState } from '@yaar/shared';
import type { ContextTape, ContextSource } from '../context.js';
import type { InteractionTimeline } from '../interaction-timeline.js';

export interface MonitorPromptContext {
  prompt: string;
  contextContent: string;
}

/** True when two window rectangles intersect (touching edges don't count). */
function rectsOverlap(a: WindowBounds, b: WindowBounds): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export class ContextAssemblyPolicy {
  /**
   * The `<open_windows>` block, in stacking order — bottom of the screen's pile first, so
   * the last line is the window the user is looking at.
   *
   * `windows` is expected in stack order (`WindowStateRegistry.stackOrder`); the position
   * in the array *is* the z rank, which is why nothing here sorts. A caller that passes an
   * unordered list still gets correct overlap facts, just an arbitrary "above/below".
   */
  formatOpenWindows(
    windows: WindowState[],
    options?: {
      monitorId?: string;
      currentWindowId?: string;
      getRawWindowId?: (handle: string) => string;
      /** The desktop's focused window, marked so the agent knows where the user is. */
      focusedWindowId?: string | null;
    },
  ): string {
    if (windows.length === 0) return '';
    const getRaw =
      options?.getRawWindowId ??
      ((id: string) => {
        const slashIdx = id.indexOf('/');
        return slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
      });
    const lines = windows.map((w, i) => {
      const label = w.title || w.content.renderer;
      const current = options?.currentWindowId === w.id ? ' (you)' : '';
      const rawId = getRaw(w.id);

      const { x, y, w: width, h } = w.bounds;
      const facts: string[] = [];
      if (w.minimized) {
        facts.push('minimized');
      } else {
        facts.push(`${width}×${h} at (${x},${y})`);
        if (w.variant !== 'panel') facts.push(`z:${i}`);
        // An overlap is only half the fact — a window that is covered is invisible to the
        // user, while one that covers is what they are reading. Splitting the two is the
        // difference between "these intersect" and "nobody can see this".
        const covers: string[] = [];
        const coveredBy: string[] = [];
        windows.forEach((o, oi) => {
          if (o === w || o.minimized || !rectsOverlap(w.bounds, o.bounds)) return;
          (oi > i ? coveredBy : covers).push(getRaw(o.id));
        });
        if (coveredBy.length > 0) facts.push(`covered by ${coveredBy.join(', ')}`);
        if (covers.length > 0) facts.push(`covers ${covers.join(', ')}`);
      }
      if (options?.focusedWindowId === w.id) facts.push('focused');
      if (w.locked) facts.push('locked');
      if (w.appId) facts.push(`app:${w.appId}`);

      return `  yaar://windows/${rawId} — ${label}${current} · ${facts.join(' · ')}`;
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

  appendUserMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('user', content, source);
  }

  appendAssistantMessage(tape: ContextTape, content: string, source: ContextSource): void {
    tape.append('assistant', content, source);
  }
}
