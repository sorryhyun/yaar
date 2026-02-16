/**
 * Selectors for the desktop store.
 */
import type { DesktopStore, WindowModel, WindowAgent } from './types';
import { getRawWindowId } from './helpers';

export const selectWindowsInOrder = (state: DesktopStore) =>
  state.zOrder.map((id) => state.windows[id]).filter(Boolean);

let _visibleCache: {
  windows: Record<string, WindowModel>;
  monitorId: string;
  result: WindowModel[];
} = { windows: {}, monitorId: '', result: [] };
/**
 * Returns visible (non-minimized) standard windows on the active monitor in
 * stable insertion order.  Z-order is intentionally NOT used here so that
 * changing focus only updates CSS z-index values without reordering DOM
 * nodes — which would cause browsers to reload iframes (e.g. YouTube videos
 * restart).
 */
export const selectVisibleWindows = (state: DesktopStore): WindowModel[] => {
  if (state.windows === _visibleCache.windows && state.activeMonitorId === _visibleCache.monitorId)
    return _visibleCache.result;
  const result = Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null &&
      !w.minimized &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? 'monitor-0') === state.activeMonitorId,
  );
  _visibleCache = { windows: state.windows, monitorId: state.activeMonitorId, result };
  return result;
};

export const selectMinimizedWindows = (state: DesktopStore) =>
  Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null &&
      w.minimized &&
      (!w.variant || w.variant === 'standard') &&
      (w.monitorId ?? 'monitor-0') === state.activeMonitorId,
  );

let _widgetCache: {
  windows: Record<string, WindowModel>;
  monitorId: string;
  result: WindowModel[];
} = { windows: {}, monitorId: '', result: [] };
export const selectWidgetWindows = (state: DesktopStore): WindowModel[] => {
  if (state.windows === _widgetCache.windows && state.activeMonitorId === _widgetCache.monitorId)
    return _widgetCache.result;
  const result = Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null &&
      !w.minimized &&
      w.variant === 'widget' &&
      (w.monitorId ?? 'monitor-0') === state.activeMonitorId,
  );
  _widgetCache = { windows: state.windows, monitorId: state.activeMonitorId, result };
  return result;
};

let _panelCache: {
  windows: Record<string, WindowModel>;
  monitorId: string;
  result: WindowModel[];
} = { windows: {}, monitorId: '', result: [] };
export const selectPanelWindows = (state: DesktopStore): WindowModel[] => {
  if (state.windows === _panelCache.windows && state.activeMonitorId === _panelCache.monitorId)
    return _panelCache.result;
  const result = Object.values(state.windows).filter(
    (w): w is WindowModel =>
      w != null && w.variant === 'panel' && (w.monitorId ?? 'monitor-0') === state.activeMonitorId,
  );
  _panelCache = { windows: state.windows, monitorId: state.activeMonitorId, result };
  return result;
};

export const selectToasts = (state: DesktopStore) => Object.values(state.toasts);

export const selectNotifications = (state: DesktopStore) => Object.values(state.notifications);

export const selectDialogs = (state: DesktopStore) => Object.values(state.dialogs);

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
