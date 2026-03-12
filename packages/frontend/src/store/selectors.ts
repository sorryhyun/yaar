/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel, WindowAgent } from './types';
import { getRawWindowId } from './helpers';
import { DEFAULT_MONITOR_ID } from '@/constants/layout';

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
 * Returns visible (non-minimized) standard windows on the active monitor in
 * stable insertion order.  Z-order is intentionally NOT used here so that
 * changing focus only updates CSS z-index values without reordering DOM
 * nodes — which would cause browsers to reload iframes (e.g. YouTube videos
 * restart).
 */
export const selectVisibleWindows = createCachedWindowSelector(
  (w) => !w.minimized && (!w.variant || w.variant === 'standard'),
);

export const selectMinimizedWindows = (state: DesktopStore) =>
  Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null &&
      w.minimized &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId,
  );

export const selectMinimizedIframeWindows = (state: DesktopStore): WindowModel[] =>
  Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null &&
      w.minimized &&
      w.content.renderer === 'iframe' &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? DEFAULT_MONITOR_ID) === state.activeMonitorId,
  );

export const selectWidgetWindows = createCachedWindowSelector(
  (w) => !w.minimized && w.variant === 'widget',
);

export const selectPanelWindows = createCachedWindowSelector((w) => w.variant === 'panel');

export const selectToasts = (state: DesktopStore) => Object.values(state.toasts);

export const selectNotifications = (state: DesktopStore) => Object.values(state.notifications);

export const selectDialogs = (state: DesktopStore) => Object.values(state.dialogs);

export const selectUserPrompts = (state: DesktopStore) => Object.values(state.userPrompts);

export const selectActiveAgents = (state: DesktopStore) => Object.values(state.activeAgents);

export const selectWindowAgents = (state: DesktopStore) => state.windowAgents;

const windowAgentSelectors = new Map<string, (state: DesktopStore) => WindowAgent | undefined>();
export const selectWindowAgent = (windowId: string) => {
  let sel = windowAgentSelectors.get(windowId);
  if (!sel) {
    const rawId = getRawWindowId(windowId);
    sel = (state: DesktopStore) =>
      Object.values(state.windowAgents).find(
        (wa) => wa.windowId === rawId || wa.windowId === windowId,
      );
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
