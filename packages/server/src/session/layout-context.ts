/**
 * LayoutContext — tracks viewport and window layout state, provides
 * per-agent deltas to inject into tool results as grounding context.
 *
 * Rules:
 * - Monitor viewport + all window positions/sizes → monitor agent
 * - Window's own size → window/app agent
 * - Only sends delta (what changed since last tool result for that agent)
 */

import type { WindowBounds } from '@yaar/shared';
import type { WindowStateRegistry } from './window-state.js';
import type { WindowHandleMap } from './window-handle-map.js';

export interface Viewport {
  w: number;
  h: number;
}

interface WindowSnapshot {
  id: string;
  rawId: string;
  title: string;
  bounds: WindowBounds;
}

interface MonitorLayoutSnapshot {
  viewport?: Viewport;
  windows: WindowSnapshot[];
}

interface WindowLayoutSnapshot {
  bounds: WindowBounds;
}

/**
 * Per-agent record of what layout state was last reported.
 */
interface AgentLayoutState {
  /** For monitor agents: last reported monitor layout */
  monitorSnapshot?: MonitorLayoutSnapshot;
  /** For window/app agents: last reported window bounds */
  windowSnapshot?: WindowLayoutSnapshot;
}

export class LayoutContext {
  /** Monitor viewport dimensions (reported by frontend). */
  private viewports = new Map<string, Viewport>();
  /** Per-agent last-seen state. */
  private agentStates = new Map<string, AgentLayoutState>();

  constructor(
    private windowState: WindowStateRegistry,
    private handleMap: WindowHandleMap,
  ) {}

  // ── Viewport updates (from frontend) ──

  setViewport(monitorId: string, viewport: Viewport): void {
    this.viewports.set(monitorId, viewport);
  }

  getViewport(monitorId: string): Viewport | undefined {
    return this.viewports.get(monitorId);
  }

  // ── Delta computation ──

  /**
   * Get layout context string for a monitor agent's tool result.
   * Returns null if nothing changed since last call for this agent.
   */
  getMonitorAgentContext(agentId: string, monitorId: string): string | null {
    const current = this.buildMonitorSnapshot(monitorId);
    const prev = this.agentStates.get(agentId)?.monitorSnapshot;

    if (prev && !this.monitorSnapshotChanged(prev, current)) {
      return null;
    }

    // Update last-seen state
    const state = this.agentStates.get(agentId) ?? {};
    state.monitorSnapshot = current;
    this.agentStates.set(agentId, state);

    return this.formatMonitorContext(current);
  }

  /**
   * Get layout context string for a window/app agent's tool result.
   * Returns null if nothing changed since last call for this agent.
   */
  getWindowAgentContext(agentId: string, windowId: string): string | null {
    const win = this.windowState.getWindow(windowId);
    if (!win) return null;

    const current: WindowLayoutSnapshot = {
      bounds: { ...win.bounds },
    };
    const prev = this.agentStates.get(agentId)?.windowSnapshot;

    if (prev && !this.boundsChanged(prev.bounds, current.bounds)) {
      return null;
    }

    const state = this.agentStates.get(agentId) ?? {};
    state.windowSnapshot = current;
    this.agentStates.set(agentId, state);

    return `[layout] window: ${current.bounds.w}×${current.bounds.h}`;
  }

  /**
   * Clean up state for a removed agent.
   */
  removeAgent(agentId: string): void {
    this.agentStates.delete(agentId);
  }

  // ── Snapshot building ──

  private buildMonitorSnapshot(monitorId: string): MonitorLayoutSnapshot {
    const viewport = this.viewports.get(monitorId);
    const handles = this.handleMap.listByMonitor(monitorId);
    const windows: WindowSnapshot[] = [];

    for (const handle of handles) {
      const win = this.windowState.getWindow(handle);
      if (!win) continue;
      windows.push({
        id: handle,
        rawId: this.handleMap.getRawWindowId(handle),
        title: win.title,
        bounds: { ...win.bounds },
      });
    }

    return { viewport, windows };
  }

  // ── Formatting ──

  private formatMonitorContext(snapshot: MonitorLayoutSnapshot): string {
    const parts: string[] = [];

    if (snapshot.viewport) {
      parts.push(`monitor: ${snapshot.viewport.w}×${snapshot.viewport.h}`);
    }

    if (snapshot.windows.length > 0) {
      const windowList = snapshot.windows
        .map(
          (w) =>
            `  ${w.rawId} "${w.title}" at (${w.bounds.x},${w.bounds.y}) ${w.bounds.w}×${w.bounds.h}`,
        )
        .join('\n');
      parts.push(`windows:\n${windowList}`);
    } else {
      parts.push('windows: (none)');
    }

    return `[layout]\n${parts.join('\n')}`;
  }

  // ── Change detection ──

  private monitorSnapshotChanged(
    prev: MonitorLayoutSnapshot,
    current: MonitorLayoutSnapshot,
  ): boolean {
    // Viewport changed?
    if (prev.viewport?.w !== current.viewport?.w || prev.viewport?.h !== current.viewport?.h) {
      return true;
    }
    // Window count changed?
    if (prev.windows.length !== current.windows.length) return true;
    // Any window bounds changed?
    const prevMap = new Map(prev.windows.map((w) => [w.id, w]));
    for (const win of current.windows) {
      const p = prevMap.get(win.id);
      if (!p) return true; // new window
      if (this.boundsChanged(p.bounds, win.bounds)) return true;
      if (p.title !== win.title) return true;
    }
    return false;
  }

  private boundsChanged(a: WindowBounds, b: WindowBounds): boolean {
    return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
  }
}
