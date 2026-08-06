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
import type { PermissionEntry } from '../http/access.js';
import { WindowHandleMap } from './window-handle-map.js';

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

/** Shared empty result for `getNoReplayCommands` — nothing may mutate it. */
const NO_COMMANDS: ReadonlySet<string> = new Set<string>();

export class WindowStateRegistry {
  private windows: Map<string, WindowState> = new Map();
  private appCommands: Map<string, AppProtocolRequest[]> = new Map();
  /**
   * Per window: the command names the *currently registered* app declared
   * `replay: 'never'` for. Keyed exactly like `appCommands` (resolved key, raw id as
   * fallback) because the two are read together at replay time — a set filed under one
   * key while the commands it filters live under another silently filters nothing.
   */
  private appNoReplay: Map<string, Set<string>> = new Map();
  /**
   * Per window: everything a caller granted *to this window* at runtime — the storage
   * files a more-privileged principal named to its app, the permissions such a caller
   * added on top of the manifest, and the document the window was told to render. Each
   * readable by the window's app for as long as the window lives.
   *
   * This is the single home of window-scoped **authority**; the iframe token carries only
   * **identity**. The token is not durable — it is re-minted on remount and on reconnect
   * (`/api/iframe-token`) from identity alone — so authority recorded on it vanishes the
   * first time the desktop reloads. Keyed like `appCommands`, and dropped by the same
   * `window.close` that drops them.
   *
   * The producers narrow, this only stores: `features/window/delegated-grants.ts` holds
   * the rules for what a payload may delegate, and `features/window/create.ts` gates the
   * caller-supplied permissions on the same `mayDelegateGrants` check. Read at the access
   * gate via `getWindowGrants`.
   */
  private delegatedGrants: Map<string, PermissionEntry[]> = new Map();
  /**
   * Stacking order, bottom to top — this registry's mirror of the desktop's `zOrder`.
   *
   * Mirrored rather than reported, because the server already sees every input that moves
   * a window in the stack: `window.create` and `window.focus` from an agent land in
   * `handleAction`, a click-to-focus arrives as a `window.focus` interaction, and a close
   * arrives both ways. The layering rules are `insertIntoZOrder` in the frontend's
   * `windowsSlice` and must stay in step with it: panels are outside the stack entirely
   * (fixed position), widgets sit below every standard window, a standard window goes on
   * top. Session-wide like the frontend's, since the keys are monitor-scoped handles;
   * `stackIndex` is what ranks a window among *its own* monitor's.
   *
   * What is deliberately not mirrored is `maximized`: the frontend computes those bounds
   * from a viewport the server does not have, so a maximized window is stored at the
   * bounds it will return to. Reporting a stack position we can derive exactly is worth
   * more than a maximize flag we would have to guess the geometry for.
   */
  private stack: string[] = [];
  /** Top of the stack among non-minimized windows — the desktop's `focusedWindowId`. */
  private focused: string | null = null;
  private onWindowCloseCallback?: (windowId: string, appId?: string, monitorId?: string) => void;

  readonly handleMap: WindowHandleMap;

  constructor(handleMap?: WindowHandleMap) {
    this.handleMap = handleMap ?? new WindowHandleMap();
  }

  setOnWindowClose(cb: (windowId: string, appId?: string, monitorId?: string) => void): void {
    this.onWindowCloseCallback = cb;
  }

  /**
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
   * The key an action that targets an **existing** window must land on, or undefined
   * if this registry holds no such window.
   *
   * Distinct from `actionKey`, which *mints* a handle. A `create` is entitled to name a
   * key that does not exist yet; nothing else is, and minting one for them is how a close
   * came to silently miss. A window restored under a bare `"process-explorer"` key (an
   * older log's unscoped id — see `getWindowRestoreActions`) sent
   * `actionKey("process-explorer", "0")` down the register branch, which answered
   * `"0/process-explorer"`: a freshly minted key holding no window. The delete removed
   * nothing, the close callback fired for a window that had not closed, and the entry
   * stayed in the registry for the rest of the process — listed to every agent, since an
   * unscoped window is listed on every monitor, and unclosable, because every later
   * attempt resolved exactly the same way.
   */
  private targetKey(rawId: string, monitorId?: string): string | undefined {
    if (this.windows.has(rawId)) return rawId;
    const handle = this.handleMap.resolve(rawId, monitorId ?? getMonitorId());
    if (handle && this.windows.has(handle)) return handle;
    return undefined;
  }

  /**
   * Determine the internal key for a **new** window: `window.create` and nothing else.
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
    // An id that is *already* a handle names one window exactly, and registering it again
    // under a monitor mints "0/1/memo" — a key nothing else ever produces, so the action
    // lands on no window and is silently dropped. Callers acting on a window that is not
    // their own (a deploy retiring the stale windows of the app it just shipped) address
    // it by handle precisely because a raw id cannot say which monitor's copy they mean.
    if (this.handleMap.getMonitorId(rawId)) return rawId;
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
    const key = this.targetKey(rawId, monitorId);
    const win = key ? this.windows.get(key) : undefined;
    if (!win) return;
    fn(win);
    win.updatedAt = Date.now();
  }

  /**
   * Put `key` on top of its own layer, removing it from wherever it was.
   *
   * Safe to call on create and on focus alike — the removal is what makes a re-focus
   * idempotent. Mirrors `insertIntoZOrder` (frontend `windowsSlice`); the two are one
   * rule expressed twice, so a change to either belongs in both.
   */
  private restack(key: string, variant?: WindowState['variant']): void {
    if (variant === 'panel') return;
    this.stack = this.stack.filter((id) => id !== key);
    if (variant === 'widget') {
      const firstStandard = this.stack.findIndex((id) => {
        const v = this.windows.get(id)?.variant;
        return !v || v === 'standard';
      });
      if (firstStandard === -1) this.stack.push(key);
      else this.stack.splice(firstStandard, 0, key);
    } else {
      this.stack.push(key);
    }
  }

  /** Highest window in the stack that is not minimized, or null. */
  private topVisible(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const id = this.stack[i];
      if (id !== undefined && !this.windows.get(id)?.minimized) return id;
    }
    return null;
  }

  /** Hand focus to whatever is on top now — after the focused window left or was hidden. */
  private refocusIfHolding(key: string): void {
    if (this.focused === key) this.focused = this.topVisible();
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
        this.restack(key, action.variant);
        // Only a standard window that is actually on screen steals focus — the same
        // condition the frontend applies.
        if ((!action.variant || action.variant === 'standard') && !action.minimized) {
          this.focused = key;
        }
        break;
      }

      case 'window.close': {
        // Never `actionKey`: a close that mints a handle deletes a key that by
        // construction holds nothing, leaving the real window behind (see `targetKey`).
        // Falling back to the raw id keeps the best-effort teardown a close of an
        // unregistered window has always had — a preview created through the iframe
        // proxy files its app commands under exactly that id.
        const key = this.targetKey(action.windowId, monitorId) ?? action.windowId;
        const appId = this.windows.get(key)?.appId;
        // Read the owner before remove() drops it — the callback needs it to find
        // the app agent that was driving this window.
        const owner = this.handleMap.getMonitorId(key) ?? monitorId;
        this.windows.delete(key);
        this.appCommands.delete(key);
        this.appNoReplay.delete(key);
        // Every spelling — see getWindowGrants for why a grant can be filed under the
        // raw id. A revoked grant that survives under another key is a live one.
        this.delegatedGrants.delete(key);
        this.delegatedGrants.delete(action.windowId);
        this.delegatedGrants.delete(this.handleMap.getRawWindowId(key));
        this.stack = this.stack.filter((id) => id !== key);
        this.refocusIfHolding(key);
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

      // The three cases below exist for the stack, and they close a gap that predates it:
      // `minimized` was written by `create` and never again, so a window an agent had
      // minimized was still described as being on screen — by `formatOpenWindows`, by
      // `list`, and by the fingerprint the reload cache is keyed on.
      case 'window.focus': {
        const key = this.targetKey(action.windowId, monitorId);
        const win = key ? this.windows.get(key) : undefined;
        if (!key || !win) break;
        win.minimized = false;
        win.updatedAt = Date.now();
        this.restack(key, win.variant);
        // A panel is outside the stack but can still hold focus, so this is set for
        // every variant — `restack` is what declines to move a panel.
        this.focused = key;
        break;
      }

      case 'window.minimize': {
        const key = this.targetKey(action.windowId, monitorId);
        const win = key ? this.windows.get(key) : undefined;
        if (!key || !win) break;
        if (win.variant === 'widget' || win.variant === 'panel') break;
        win.minimized = true;
        win.updatedAt = Date.now();
        this.refocusIfHolding(key);
        break;
      }

      // Restores visibility only. A maximized window's bounds are the frontend's to
      // restore (see `stack`) — this registry never recorded them as changed.
      case 'window.restore':
        this.mutateWindow(action.windowId, monitorId, (win) => {
          win.minimized = false;
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
        // Reading a log, not routing a message: an interaction recorded before
        // monitors were stamped genuinely has no monitor, and the alternative to
        // placing it on the default desktop is dropping the user's window.
        const monitorId = interaction.monitorId ?? DEFAULT_MONITOR_ID;
        // The action carries the *scoped handle*, not the raw id the click arrived with.
        // This action is what gets logged, and the log is what the next launch restores
        // from — while every later interaction on this window (`close:0/notes`) names it
        // by handle. Logged raw, the two never matched: `getWindowRestoreActions` deleted
        // nothing on close, so every window the user had opened by hand came back on the
        // next launch, under a bare key no close could then address.
        const windowId = this.actionKey(interaction.windowId, monitorId);
        const createAction: OSAction = {
          type: 'window.create',
          windowId,
          title: interaction.windowTitle ?? interaction.windowId,
          bounds: interaction.bounds,
          content: interaction.content,
          variant: appMeta?.variant,
          dockEdge: appMeta?.dockEdge,
          frameless: appMeta?.frameless,
          windowStyle: appMeta?.windowStyle,
          appId: interaction.appId,
        };
        this.handleAction(createAction, monitorId);
        return [createAction];
      }

      case 'window.close': {
        if (!interaction.windowId) return [];
        const closeAction: OSAction = { type: 'window.close', windowId: interaction.windowId };
        this.handleAction(closeAction, interaction.monitorId);
        return [closeAction];
      }

      // Click-to-focus, and the taskbar button that brings a minimized window back —
      // both arrive here, and both are what keeps the mirrored stack (see `stack`)
      // honest about a user who has been rearranging their own desktop.
      case 'window.focus':
      case 'window.minimize': {
        if (!interaction.windowId) return [];
        const action: OSAction = { type: interaction.type, windowId: interaction.windowId };
        this.handleAction(action, interaction.monitorId);
        return [action];
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
        this.handleAction(moveAction, interaction.monitorId);
        this.handleAction(resizeAction, interaction.monitorId);
        return [moveAction, resizeAction];
      }

      default:
        return [];
    }
  }

  /**
   * The windows this session is tracking; with a `monitorId`, only that monitor's.
   *
   * A monitor is a separate desktop, so a prompt built for one must not describe the
   * other's windows — an agent on monitor 1 that is handed monitor 0's open windows
   * will happily update them, and its overlap arithmetic is over rectangles the user
   * cannot see. Windows on no monitor (the unscoped anomaly `actionKey` warns about,
   * and pre-monitor restores) are listed for every monitor, since the frontend puts
   * them on whichever monitor is active.
   */
  listWindows(monitorId?: string): WindowState[] {
    const all = Array.from(this.windows.entries());
    if (monitorId === undefined) return all.map(([, win]) => win);
    return all
      .filter(([handle]) => {
        const owner = this.handleMap.getMonitorId(handle);
        return owner === undefined || owner === monitorId;
      })
      .map(([, win]) => win);
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

  /**
   * The key the per-window app maps (`appCommands`, `appNoReplay`) file a window under.
   *
   * Resolved key where the window is known, raw id where it is not — a window may be
   * addressed before it exists in this registry (a preview created through the iframe
   * proxy, a restored id), and dropping the record entirely would lose it. Every app map
   * must use this one function: `recordAppCommand` writing under "0/memo" while
   * `getNoReplayCommands` reads under "memo" is a filter that quietly never matches.
   */
  private appKey(windowId: string): string {
    return this.resolve(windowId)?.[0] ?? windowId;
  }

  recordAppCommand(windowId: string, request: AppProtocolRequest): void {
    const key = this.appKey(windowId);
    let commands = this.appCommands.get(key);
    if (!commands) {
      commands = [];
      this.appCommands.set(key, commands);
    }
    commands.push(request);
  }

  getAppCommands(windowId: string): AppProtocolRequest[] {
    return this.appCommands.get(this.appKey(windowId)) ?? [];
  }

  /**
   * Record storage files delegated to this window's app (see `delegatedGrants`).
   *
   * Additive and deduplicated by URI: a second command naming the same file must not
   * grow the list, and each call adds to what earlier ones granted rather than replacing
   * it — an agent that opens a file, then opens a second one, meant both.
   */
  grantWindowAccess(windowId: string, entries: readonly PermissionEntry[], monitorId?: string) {
    if (entries.length === 0) return;
    // `window.create` records its grants *before* the emit, so the window does not exist
    // yet and `targetKey` finds nothing. Falling back to the bare raw id filed the grant
    // under a key every monitor's copy of the same app resolves to; `handleFor` gives the
    // handle the create is about to register, without registering it.
    const key =
      this.targetKey(windowId, monitorId) ?? this.handleMap.handleFor(windowId, monitorId);
    const existing = this.delegatedGrants.get(key) ?? [];
    const seen = new Set(existing.map((e) => (typeof e === 'string' ? e : e.uri)));
    const added = entries.filter((e) => {
      const uri = typeof e === 'string' ? e : e.uri;
      if (seen.has(uri)) return false;
      seen.add(uri);
      return true;
    });
    if (added.length > 0) this.delegatedGrants.set(key, [...existing, ...added]);
  }

  /**
   * Storage files delegated to this window's app. Empty for every other window.
   *
   * `monitorId` is passed explicitly by the access gate: the grant is *recorded* inside
   * an agent turn, which carries a monitor, but it is *read* on an HTTP request, which
   * carries none — and a raw window id repeats across monitors, so an ambient-only
   * lookup finds nothing for any app open on two of them. The iframe token pins the
   * monitor at mint time precisely so this lookup can be exact.
   */
  getWindowGrants(windowId: string, monitorId?: string): PermissionEntry[] {
    const key =
      this.targetKey(windowId, monitorId) ?? this.handleMap.handleFor(windowId, monitorId);
    // Every spelling of this one window, unioned. A caller may ask by raw id (an agent
    // turn) or by handle (an iframe token minted at reconnect), and a grant recorded by a
    // path that had no monitor to scope it with still sits under the bare raw id. Reading
    // only the resolved key is how a file named at create time stopped being granted the
    // moment the desktop reloaded and the token came back naming the handle.
    const out: PermissionEntry[] = [];
    const seen = new Set<string>();
    for (const spelling of [key, windowId, this.handleMap.getRawWindowId(windowId)]) {
      if (seen.has(spelling)) continue;
      seen.add(spelling);
      const entries = this.delegatedGrants.get(spelling);
      if (entries) out.push(...entries);
    }
    return out;
  }

  /**
   * Record that a window's iframe app has registered, and with what replay policy.
   *
   * `noReplay` is the set of command names the registration that *just came up* declared
   * `replay: 'never'` for, and it **replaces** whatever the previous registration said —
   * an app that dropped the opt-out in a rebuild must not keep being filtered by a policy
   * it no longer declares. Absent (or empty) therefore *clears* the set rather than
   * leaving the previous one standing.
   */
  setAppProtocol(windowId: string, noReplay?: readonly string[]): void {
    const win = this.getState(windowId);
    if (win) {
      win.appProtocol = true;
      win.updatedAt = Date.now();
    }
    const key = this.appKey(windowId);
    if (noReplay && noReplay.length > 0) this.appNoReplay.set(key, new Set(noReplay));
    else this.appNoReplay.delete(key);
  }

  /**
   * Command names the window's current registration opted out of replay.
   *
   * Empty for every app that says nothing, which is what keeps `replay` optional: an app
   * that never heard of the field replays exactly as it always did.
   */
  getNoReplayCommands(windowId: string): ReadonlySet<string> {
    return this.appNoReplay.get(this.appKey(windowId)) ?? NO_COMMANDS;
  }

  hasWindow(windowId: string): boolean {
    return this.getState(windowId) !== undefined;
  }

  /**
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

  /**
   * This monitor's windows, bottom of the stack to top — the last entry is on top.
   *
   * Ranked among the monitor's own windows, not the session's: a monitor is a separate
   * desktop, so "third from the bottom" has to mean third on *that* screen. Panels are
   * outside the stack (fixed position, no stacking) and are appended after the ranked
   * ones so a caller iterating this still sees every window.
   */
  stackOrder(monitorId?: string): WindowState[] {
    const listed = this.listWindows(monitorId);
    const rank = new Map(listed.map((win) => [win.id, this.stack.indexOf(win.id)]));
    return [...listed].sort((a, b) => {
      const ra = rank.get(a.id) ?? -1;
      const rb = rank.get(b.id) ?? -1;
      // -1 is "not in the stack" (a panel); keep those last, in listing order.
      if (ra === -1 || rb === -1) return ra === rb ? 0 : ra === -1 ? 1 : -1;
      return ra - rb;
    });
  }

  /**
   * Where a window sits in its monitor's stack: `0` is the bottom, and `undefined` means
   * it does not stack at all (a panel) or is not a window this registry holds.
   */
  stackIndex(windowId: string, monitorId?: string): number | undefined {
    const resolved = this.resolve(windowId);
    if (!resolved) return undefined;
    const [key] = resolved;
    if (!this.stack.includes(key)) return undefined;
    const owner = monitorId ?? this.handleMap.getMonitorId(key);
    const idx = this.stackOrder(owner).findIndex((win) => win.id === key);
    return idx === -1 ? undefined : idx;
  }

  /** The window the desktop has focused, or null. Session-wide, like the desktop's. */
  getFocusedWindowId(): string | null {
    return this.focused;
  }

  clear(): void {
    this.windows.clear();
    this.appCommands.clear();
    this.appNoReplay.clear();
    this.stack = [];
    this.focused = null;
    this.handleMap.clear();
  }

  getWindowCount(): number {
    return this.windows.size;
  }

  restoreFromActions(actions: OSAction[]): void {
    for (const action of actions) {
      // Registered *before* the action is applied, not after. Restored ids are scoped
      // handles ("0/dock"), and `actionKey` short-circuits on an id the handle map
      // already knows — so registering first is what makes a restored window resolvable
      // by its raw id from the very first action, rather than only from the second.
      // `getWindowRestoreActions` guarantees the scoping; an id that somehow arrives
      // bare is a no-op here and warns in `actionKey`.
      const windowId = (action as { windowId?: string }).windowId;
      if (windowId) {
        this.handleMap.registerHandle(windowId);
      }
      this.handleAction(action);
    }
  }
}
