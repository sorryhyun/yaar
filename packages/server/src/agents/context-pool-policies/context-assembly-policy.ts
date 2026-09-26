import type {
  FormFactor,
  Orientation,
  UserInteraction,
  WindowBounds,
  WindowState,
} from '@yaar/shared';
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

/** What a monitor's screen is, as far as the prompt needs to know. */
export interface MonitorDevice {
  formFactor: FormFactor;
  /** With the soft keyboard down — see `SubscribeMonitorEvent.viewport`. */
  viewport?: { w: number; h: number };
  orientation?: Orientation;
}

/**
 * Told every turn on a phone, not once: the monitor's tab can switch form factor or be
 * turned mid-session (rotation, a desktop tab taking over), and an agent that saw
 * "phone" ten turns ago in a compacted context has no reason to still believe it.
 *
 * The layout advice follows the orientation. "One narrow column" is right for a phone
 * held upright and wrong for one on its side, where the screen is wide and only a few
 * hundred pixels tall — stacking there is what pushes content below the fold.
 */
function formatDevice(device: MonitorDevice): string {
  const orientation = device.orientation ? ` orientation="${device.orientation}"` : '';
  const screen = device.viewport ? ` screen="${device.viewport.w}×${device.viewport.h}"` : '';
  const layout =
    device.orientation === 'landscape'
      ? 'The phone is turned sideways: the screen is wide but short, so keep vertical ' +
        'chrome to a minimum (one compact header, no stacked banners) and put content ' +
        'side by side rather than in a tall column; no fixed pixel sizes, large tap ' +
        'targets, short titles.'
      : 'Lay content out as one narrow column: no side-by-side panes, no fixed pixel ' +
        'widths, large tap targets, short titles.';
  return (
    `<device form_factor="mobile"${orientation}${screen}>The user is on a phone. Every ` +
    'window is shown full-screen, one at a time — the last visible window in ' +
    '<open_windows> is the one on screen — so x/y/width/height and tiling are ignored. ' +
    `${layout}</device>\n\n`
  );
}

export class ContextAssemblyPolicy {
  /**
   * @param deviceOf The screen behind a monitor. Absent (tests) means every monitor is a
   *   desktop.
   */
  constructor(private readonly deviceOf?: (monitorId: string) => MonitorDevice | undefined) {}

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
    const device = options?.monitorId ? this.deviceOf?.(options.monitorId) : undefined;
    const mobile = device?.formFactor === 'mobile';
    const devicePrefix = mobile ? formatDevice(device) : '';
    if (windows.length === 0) return devicePrefix;
    // On a phone the card on top is the only thing the user can see; bounds and overlaps
    // describe a layout that is not on screen.
    const onScreen = mobile
      ? [...windows].reverse().find((w) => !w.minimized && (!w.variant || w.variant === 'standard'))
      : undefined;
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
      } else if (mobile) {
        facts.push(w === onScreen ? 'on screen' : 'behind');
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
    return `${devicePrefix}<open_windows${monitor}>\n${lines.join('\n')}\n</open_windows>\n\n`;
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
