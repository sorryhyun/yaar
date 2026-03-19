/**
 * Notification business logic.
 *
 * Handles showing and dismissing user notifications via OS Actions.
 */

import type { OSAction } from '@yaar/shared';
import { actionEmitter } from '../../session/action-emitter.js';

export interface ShowNotificationPayload {
  id?: string;
  title: string;
  body?: string;
  icon?: string;
}

/**
 * Show a notification to the user.
 *
 * Generates an id if not provided, emits the notification.show action,
 * and returns the id and a success message.
 */
export function showNotification(payload: ShowNotificationPayload): {
  id: string;
  message: string;
} {
  const id = payload.id || `notif-${Date.now().toString(36)}`;
  const osAction: OSAction = {
    type: 'notification.show',
    id,
    title: payload.title,
    body: payload.body ?? '',
    icon: payload.icon,
  };
  actionEmitter.emitAction(osAction);
  return { id, message: `Notification "${payload.title}" shown` };
}

/**
 * Dismiss a notification by id.
 */
export function dismissNotification(id: string): void {
  const osAction: OSAction = {
    type: 'notification.dismiss',
    id,
  };
  actionEmitter.emitAction(osAction);
}
