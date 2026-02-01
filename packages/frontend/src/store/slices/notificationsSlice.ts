/**
 * Notifications slice - manages notification center.
 */
import type { SliceCreator, NotificationsSlice, DesktopStore } from '../types'
import type { OSAction } from '@claudeos/shared'

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, _get) => ({
  notifications: {},

  handleNotificationAction: (action: OSAction) => set((state) => {
    switch (action.type) {
      case 'notification.show': {
        state.notifications[action.id] = {
          id: action.id,
          title: action.title,
          body: action.body,
          icon: action.icon,
          timestamp: Date.now(),
        }
        break
      }
      case 'notification.dismiss': {
        delete state.notifications[action.id]
        break
      }
    }
  }),

  dismissNotification: (id) => set((state) => {
    const notification = state.notifications[id]
    delete state.notifications[id]
    ;(state as DesktopStore).interactionLog.push({
      type: 'notification.dismiss',
      timestamp: Date.now(),
      details: notification?.title,
    })
  }),
})
