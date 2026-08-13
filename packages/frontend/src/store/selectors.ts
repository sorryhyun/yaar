/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel, WindowAgent } from './types';
// Window IDs are opaque handles — no parsing needed.
import { DEFAULT_MONITOR_ID } from '@yaar/shared';

export const selectWindowsInOrder = (state: DesktopStore) =>
  state.zOrder.map((id) => state.windows[id]).filter(Boolean);

/** Factory for cached window selectors with monitor-scoping. */
function createCachedWindowSelector(
  predicate: (w: WindowModel) => boolean,
): (state: DesktopStore) => WindowModel[] {
  let cache: {
    windows: Record<string, WindowModel>;
    monitorId: string;
    result: WindowModel[];
  } = { windows: {}, monitorId: '', result: [] };

  return (state: DesktopStore): WindowModel[] => {
    if (state.windows === cache.windows && state.activeMonitorId === cache.monitorId)
      return cache.result;
    const result = Object.values(state.windows).filter(
      (w): w is WindowModel =>
        w != null && predicate(w) && (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId,
    );
    cache = { windows: state.windows, monitorId: state.activeMonitorId, result };
    return result;
  };
}

/**
 * Returns visible (non-minimized) standard, non-iframe windows on the active
 * monitor in stable insertion order. Z-order is intentionally NOT used here
 * so that changing focus only updates CSS z-index values without reordering
 * DOM nodes. Iframe-renderer windows are excluded — they're rendered from a
 * separate, persistent list (`selectAllIframeWindows`, used in
 * `components/desktop/WindowManager.tsx`) to prevent remounts.
 */
export const selectVisibleWindows = createCachedWindowSelector(
  (w) =>
    !w.minimized && (!w.variant || w.variant === 'standard') && w.content.renderer !== 'iframe',
);

/**
 * Every standard window on the active monitor — the row the taskbar under the input bar
 * renders.
 *
 * It used to be the minimized ones only, which made that row a place windows went rather
 * than a way to reach them: an open window had no tab, so there was nothing to click to
 * raise one buried under three others, and nothing at all to look at that said what the
 * desktop was holding. Minimized is a *state* of a tab here, not the condition for having
 * one.
 *
 * Insertion order, like `selectVisibleWindows` and for the same reason: focus must not
 * reorder the row, or a tab moves out from under the pointer between clicks.
 */
export const selectTaskbarWindows = createCachedWindowSelector(
  (w) => !w.variant || w.variant === 'standard',
);

/**
 * ALL iframe windows across every monitor — rendered in a single React list so
 * that switching monitors only toggles `hidden` via CSS instead of
 * unmounting/remounting, which would destroy iframe state.
 */
export const selectAllIframeWindows = (state: DesktopStore): WindowModel[] =>
  Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null && w.content.renderer === 'iframe' && (!w.variant || w.variant === 'standard'),
  );

export const selectWidgetWindows = createCachedWindowSelector(
  (w) => !w.minimized && w.variant === 'widget',
);

export const selectPanelWindows = createCachedWindowSelector((w) => w.variant === 'panel');

/** Whether a visible standard window fills the active monitor. */
export const selectHasMaximizedWindow = (state: DesktopStore): boolean =>
  Object.values(state.windows).some(
    (w) =>
      w != null &&
      w.maximized &&
      !w.minimized &&
      !w.windowStyle &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId,
  );

export const selectToasts = (state: DesktopStore) => Object.values(state.toasts);

export const selectNotifications = (state: DesktopStore) => Object.values(state.notifications);

export const selectDialogs = (state: DesktopStore) => Object.values(state.dialogs);

export const selectUserPrompts = (state: DesktopStore) => Object.values(state.userPrompts);

export const selectActiveAgents = (state: DesktopStore) => Object.values(state.activeAgents);

export const selectWindowAgents = (state: DesktopStore) => state.windowAgents;

let windowAgentReverseCache: {
  agents: Record<string, WindowAgent>;
  map: Map<string, WindowAgent>;
} = { agents: {}, map: new Map() };

function getWindowAgentMap(agents: Record<string, WindowAgent>): Map<string, WindowAgent> {
  if (agents === windowAgentReverseCache.agents) return windowAgentReverseCache.map;
  const map = new Map<string, WindowAgent>();
  for (const key in agents) {
    const wa = agents[key];
    map.set(wa.windowId, wa);
  }
  windowAgentReverseCache = { agents, map };
  return map;
}

const windowAgentSelectors = new Map<string, (state: DesktopStore) => WindowAgent | undefined>();
export const selectWindowAgent = (windowId: string) => {
  let sel = windowAgentSelectors.get(windowId);
  if (!sel) {
    sel = (state: DesktopStore) => getWindowAgentMap(state.windowAgents).get(windowId);
    windowAgentSelectors.set(windowId, sel);
  }
  return sel;
};

const queuedActionsCountSelectors = new Map<string, (state: DesktopStore) => number>();
export const selectQueuedActionsCount = (windowId: string) => {
  let sel = queuedActionsCountSelectors.get(windowId);
  if (!sel) {
    sel = (state: DesktopStore) => state.queuedActions[windowId]?.length ?? 0;
    queuedActionsCountSelectors.set(windowId, sel);
  }
  return sel;
};
