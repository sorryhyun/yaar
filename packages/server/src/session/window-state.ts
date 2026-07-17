/**
 * Window state tracker - maintains server-side state of windows.
 *
 * Tracks windows created via actions and provides query methods
 * for list_windows and view_window tools.
 *
 * Delegates handle creation/resolution to WindowHandleMap — this class
 * never constructs composite keys directly.
 */

import type { OSAction, WindowState, AppProtocolRequest, UserInteraction } from '@yaar/shared';
import { applyContentOperation, DEFAULT_MONITOR_ID } from '@yaar/shared';
import { getMonitorId } from '../agents/agent-context.js';
import { WindowHandleMap } from './window-handle-map.js';

// Re-export WindowState for convenience
export type { WindowState } from '@yaar/shared';

/**
 * The window-shaping half of an app's manifest — the fields a `window.create` for that
 * app inherits. Narrower than what app discovery returns on purpose: this module has no
 * business knowing about permissions or bundles.
 */
export interface AppWindowMeta {
  variant?: WindowState['variant'];
  dockEdge?: WindowState['dockEdge'];
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
}

/**
 * Window state registry for one connection/session.
 */
export class WindowStateRegistry {
  private windows: Map<string, WindowState> = new Map();
  private appCommands: Map<string, AppProtocolRequest[]> = new Map();
  private onWindowCloseCallback?: (windowId: string, appId?: string, monitorId?: string) => void;

  readonly handleMap: WindowHandleMap;

  constructor(handleMap?: WindowHandleMap) {
    this.handleMap = handleMap ?? new WindowHandleMap();
  }

  /**
   * Set a callback to be invoked when a window is closed.
   * Used to invalidate reload cache entries that depend on the closed window.
   */
  setOnWindowClose(cb: (windowId: string, appId?: string, monitorId?: string) => void): void {
    this.onWindowCloseCallback = cb;
  }

  /**
   * Resolve a windowId (raw or handle) to its internal map key.
   * Returns the resolved key and the stored WindowState, or undefined.
   *
   * Raw IDs are only unique within a monitor (they are derived from the appId), so
   * a raw lookup is scoped to the caller's monitor — taken from the ambient agent
   * context, since an agent may only address windows on the monitor it runs on.
   * Without that scope an agent on monitor 1 asking for "devtools" could resolve
   * into monitor 0's copy of the app. Outside an agent turn (HTTP, restore) the
   * handle map falls back to resolving unambiguous raw IDs.
   */
  private resolve(windowId: string): [string, WindowState] | undefined {
    // 1. Exact match (handle or legacy raw key)
    const exact = this.windows.get(windowId);
    if (exact) return [windowId, exact];

    // 2. Resolve via handle map (raw ID → handle), scoped to the caller's monitor
    const handle = this.handleMap.resolve(windowId, getMonitorId());
    if (handle) {
      const state = this.windows.get(handle);
      if (state) return [handle, state];
    }

    return undefined;
  }

  /**
   * Determine the internal key for a given action windowId + monitorId.
   *
   * Every key here should be monitor-scoped — either because a monitor was passed, or
   * because the id already carries one ("0/dock", as restore replays them). A key that
   * is neither is a window on no monitor, which is not a thing: it means some path
   * emitted a window action without resolving a monitor, and the frontend — which
   * always picks one — will key the same window differently. That divergence is how one
   * app came to show as two windows, and it is silent, so name it when it happens.
   * ActionEmitter.resolveWindowMonitor() exists to keep this from being reachable.
   */
  private actionKey(rawId: string, monitorId?: string): string {
    if (monitorId) return this.handleMap.register(rawId, monitorId);
    // Backward compat: try to find an existing handle for this raw ID
    const resolved = this.resolve(rawId);
    if (resolved) return resolved[0];
    if (!rawId.includes('/')) {
      console.warn(
        `[WindowStateRegistry] Unscoped window key "${rawId}" — the action carried no monitor ` +
          `and none could be resolved. The frontend will place this window on its active ` +
          `monitor, so the two registries now disagree about its key.`,
      );
    }
    return rawId;
  }

  /**
   * Resolve a window action's target and hand it to `fn`, if the window still exists.
   *
   * Seven of the nine window actions have this shape — resolve the key, drop the action if
   * the window is gone, mutate, stamp `updatedAt`. (`create` and `close` do not: one has no
   * window to resolve yet, the other has none left to stamp.) The stamp is why this is a
   * method and not seven copies: it is the one line that has nothing to do with what the
   * caller came to change, which is exactly the line a new case forgets, and a window that
   * changed while claiming it did not is a window whose watchers are never told.
   */
  private mutateWindow(
    rawId: string,
    monitorId: string | undefined,
    fn: (win: WindowState) => void,
  ): void {
    const key = this.actionKey(rawId, monitorId);
    const win = this.windows.get(key);
    if (!win) return;
    fn(win);
    win.updatedAt = Date.now();
  }

  handleAction(action: OSAction, monitorId?: string): void {
    switch (action.type) {
      case 'window.create': {
        const now = Date.now();
        const key = this.actionKey(action.windowId, monitorId);
        this.windows.set(key, {
          id: key,
          title: action.title,
          bounds: { ...action.bounds },
          content: { ...action.content },
          locked: false,
          ...(action.appId ? { appId: action.appId } : {}),
          variant: action.variant,
          dockEdge: action.dockEdge,
          frameless: action.frameless,
          windowStyle: action.windowStyle,
          minimized: action.minimized,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }

      case 'window.close': {
        const key = this.actionKey(action.windowId, monitorId);
        const appId = this.windows.get(key)?.appId;
        // Read the owner before remove() drops it — the callback needs it to find
        // the app agent that was driving this window.
        const owner = this.handleMap.getMonitorId(key) ?? monitorId;
        this.windows.delete(key);
        this.appCommands.delete(key);
        this.handleMap.remove(key);
        this.onWindowCloseCallback?.(key, appId, owner);
        break;
      }

      case 'window.setTitle':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.title = action.title;
        });
        break;

      case 'window.setContent':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.content = { ...action.content };
        });
        break;

      case 'window.updateContent':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.content.data = applyContentOperation(win.content.data ?? '', action.operation);
          if (action.renderer) {
            win.content.renderer = action.renderer;
          }
        });
        break;

      case 'window.move':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
        });
        break;

      case 'window.resize':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
        });
        break;

      case 'window.lock':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.locked = true;
          win.lockedBy = action.agentId;
        });
        break;

      case 'window.unlock':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.locked = false;
          win.lockedBy = undefined;
        });
        break;
    }
  }

  /**
   * Apply an interaction the *user* performed on a window, and return the actions it
   * amounted to.
   *
   * This translation belongs here rather than in the caller because all of it is window
   * state: the shape of a user-made `window.create`, the fact that a drag-resize is a
   * move *and* a resize, and the monitor a monitor-less interaction lands on. What is not
   * window state stays with the caller — logging, and the browser sessions that a closed
   * browser window happens to own.
   *
   * `loadAppMeta` is injected rather than imported: it is consulted only for a create that
   * names an app, and a window registry has no business reaching into app discovery.
   */
  async applyUserInteraction(
    interaction: UserInteraction,
    loadAppMeta: (appId: string) => Promise<AppWindowMeta | null>,
  ): Promise<OSAction[]> {
    switch (interaction.type) {
      case 'window.create': {
        if (!interaction.windowId || !interaction.content || !interaction.bounds) return [];
        const appMeta = interaction.appId ? await loadAppMeta(interaction.appId) : null;
        const createAction: OSAction = {
          type: 'window.create',
          windowId: interaction.windowId,
          title: interaction.windowTitle ?? interaction.windowId,
          bounds: interaction.bounds,
          content: interaction.content,
          variant: appMeta?.variant,
          dockEdge: appMeta?.dockEdge,
          frameless: appMeta?.frameless,
          windowStyle: appMeta?.windowStyle,
          appId: interaction.appId,
        };
        // Reading a log, not routing a message: an interaction recorded before
        // monitors were stamped genuinely has no monitor, and the alternative to
        // placing it on the default desktop is dropping the user's window.
        this.handleAction(createAction, interaction.monitorId ?? DEFAULT_MONITOR_ID);
        return [createAction];
      }

      case 'window.close': {
        if (!interaction.windowId) return [];
        const closeAction: OSAction = { type: 'window.close', windowId: interaction.windowId };
        this.handleAction(closeAction);
        return [closeAction];
      }

      case 'window.move':
      case 'window.resize': {
        if (!interaction.windowId || !interaction.bounds) return [];
        const b = interaction.bounds;
        const moveAction: OSAction = {
          type: 'window.move',
          windowId: interaction.windowId,
          x: b.x,
          y: b.y,
        };
        const resizeAction: OSAction = {
          type: 'window.resize',
          windowId: interaction.windowId,
          w: b.w,
          h: b.h,
        };
        this.handleAction(moveAction);
        this.handleAction(resizeAction);
        return [moveAction, resizeAction];
      }

      default:
        return [];
    }
  }

  listWindows(): WindowState[] {
    return Array.from(this.windows.values());
  }

  /**
   * The live state of a window, by handle or raw id, or undefined if there is no such
   * window on the caller's monitor. The object is the registry's own — mutating it
   * mutates the window (see `setAppProtocol`), so callers that only ask a question
   * should only read.
   */
  getState(windowId: string): WindowState | undefined {
    return this.resolve(windowId)?.[1];
  }

  getWindow(windowId: string): WindowState | undefined {
    return this.getState(windowId);
  }

  recordAppCommand(windowId: string, request: AppProtocolRequest): void {
    const resolved = this.resolve(windowId);
    const key = resolved ? resolved[0] : windowId;
    let commands = this.appCommands.get(key);
    if (!commands) {
      commands = [];
      this.appCommands.set(key, commands);
    }
    commands.push(request);
  }

  getAppCommands(windowId: string): AppProtocolRequest[] {
    const resolved = this.resolve(windowId);
    const key = resolved ? resolved[0] : windowId;
    return this.appCommands.get(key) ?? [];
  }

  setAppProtocol(windowId: string): void {
    const win = this.getState(windowId);
    if (win) {
      win.appProtocol = true;
      win.updatedAt = Date.now();
    }
  }

  hasWindow(windowId: string): boolean {
    return this.getState(windowId) !== undefined;
  }

  /**
   * Check if a window is locked by a different agent.
   * Returns the locking agent's ID if locked by someone else, or null if not locked / locked by the same agent.
   */
  isLockedByOther(windowId: string, agentId?: string): string | null {
    const win = this.getState(windowId);
    if (!win) return null;
    if (!win.locked) return null;
    if (agentId && win.lockedBy === agentId) return null;
    return win.lockedBy ?? 'unknown';
  }

  getAppIdForWindow(windowId: string): string | undefined {
    return this.getState(windowId)?.appId;
  }

  /**
   * The monitor that owns this window, or undefined for legacy/restored windows
   * whose handle carries no monitor. App agents are keyed by this — a window's
   * monitor is what decides which monitor's app agent may drive it.
   */
  getMonitorForWindow(windowId: string): string | undefined {
    const resolved = this.resolve(windowId);
    return resolved ? this.handleMap.getMonitorId(resolved[0]) : undefined;
  }

  isAppProtocolWindow(windowId: string): boolean {
    const win = this.getState(windowId);
    if (!win) return false;
    return win.appProtocol === true && !!win.appId;
  }

  clear(): void {
    this.windows.clear();
    this.appCommands.clear();
    this.handleMap.clear();
  }

  getWindowCount(): number {
    return this.windows.size;
  }

  restoreFromActions(actions: OSAction[]): void {
    for (const action of actions) {
      this.handleAction(action);
      // Restored actions have scoped windowIds (e.g., "0/dock").
      // Register the handle mapping so raw-ID lookups work for verb tools.
      const windowId = (action as { windowId?: string }).windowId;
      if (windowId) {
        this.handleMap.registerHandle(windowId);
      }
    }
  }
}
