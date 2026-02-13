/**
 * Notifications slice - manages notification center.
 */
import type {
  SliceCreator,
  NotificationsSlice,
  NotificationsSliceState,
  DesktopStore,
} from '../types';
import type { OSAction } from '@yaar/shared';

/**
 * Pure mutation function that applies a notification action to an Immer draft.
 */
export function applyNotificationAction(state: NotificationsSliceState, action: OSAction): void {
  switch (action.type) {
    case 'notification.show': {
      state.notifications[action.id] = {
        id: action.id,
        title: action.title,
        body: action.body,
        icon: action.icon,
        duration: action.duration,
        timestamp: Date.now(),
      };
      break;
    }
    case 'notification.dismiss': {
      delete state.notifications[action.id];
      break;
    }
  }
}

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
