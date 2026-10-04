/**
 * Notifications slice - manages notification center.
 */
import type { SliceCreator, DesktopStore } from '../types';
import type { NotificationModel } from '@/types/state';
import type { NotificationShowAction, OSAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

export interface NotificationsSliceState {
  notifications: Record<string, NotificationModel>;
}

export interface NotificationsSliceActions {
  dismissNotification: (id: string) => void;
}

export type NotificationsSlice = NotificationsSliceState & NotificationsSliceActions;

const applyShowOrDismiss = createApplyAction<
  NotificationsSliceState,
  NotificationModel,
  NotificationShowAction
>(
  'notifications',
  'notification.show',
  (action) => ({
    id: action.id,
    title: action.title,
    body: action.body,
    icon: action.icon,
    duration: action.duration,
    monitorId: action.monitorId,
    timestamp: Date.now(),
  }),
  'notification.dismiss',
);

/**
 * Pure mutation function that applies a notification action to an Immer draft.
 *
 * A monitor shows only its newest notification: a show drops any other notification from
 * the same monitor (notifications with no monitor share one slot). The server's
 * `SurfaceRegistry` keeps the same rule, so a snapshot cannot bring the replaced ones back.
 * The dropped ones are not reported as dismissed — the user never closed them.
 */
export function applyNotificationAction(state: NotificationsSliceState, action: OSAction): void {
  if (action.type === 'notification.show') {
    for (const [id, n] of Object.entries(state.notifications)) {
      if (id !== action.id && n.monitorId === action.monitorId) delete state.notifications[id];
    }
  }
  applyShowOrDismiss(state, action);
}

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, _get) => ({
  notifications: {},

  dismissNotification: (id) =>
    set((state) => {
      const notification = state.notifications[id];
      delete state.notifications[id];
      (state as DesktopStore).pendingInteractions.push({
        type: 'notification.dismiss',
        timestamp: Date.now(),
        notificationId: id,
        details: notification?.title,
      });
    }),
});
