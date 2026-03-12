/**
 * Notifications slice - manages notification center.
 */
import type {
  SliceCreator,
  NotificationsSlice,
  NotificationsSliceState,
  DesktopStore,
} from '../types';
import type { OSAction, NotificationShowAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

/**
 * Pure mutation function that applies a notification action to an Immer draft.
 */
export const applyNotificationAction = createApplyAction<
  NotificationsSliceState,
  { id: string; title: string; body: string; icon?: string; duration?: number; timestamp: number }
>(
  'notifications',
  'notification.show',
  (action: NotificationShowAction) => ({
    id: action.id,
    title: action.title,
    body: action.body,
    icon: action.icon,
    duration: action.duration,
    timestamp: Date.now(),
  }),
  'notification.dismiss',
);

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, _get) => ({
  notifications: {},

  handleNotificationAction: (action: OSAction) =>
    set((state) => {
      applyNotificationAction(state, action);
    }),

  dismissNotification: (id) =>
    set((state) => {
      const notification = state.notifications[id];
      delete state.notifications[id];
      (state as DesktopStore).pendingInteractions.push({
        type: 'notification.dismiss',
        timestamp: Date.now(),
        details: notification?.title,
      });
    }),
});
