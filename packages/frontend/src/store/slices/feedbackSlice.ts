/**
 * Feedback slice - manages rendering feedback for the server.
 */
import type { SliceCreator } from '../types';
import type { AppProtocolResponse } from '@yaar/shared';
import type { RenderingFeedback } from '@/types/state';
import { createConsumeQueue } from '../helpers';

export interface AppProtocolResponseItem {
  requestId: string;
  windowId: string;
  response: AppProtocolResponse;
}

export interface AppInteractionItem {
  windowId: string;
  content: string;
  instructions?: string;
  toMonitor?: boolean;
}

export interface AppEventItem {
  windowId: string;
  channel: string;
  payload: unknown;
  /** `app.emit(..., { wakeAgent: true })` — also wake the app's own agent. */
  wakeAgent?: boolean;
}

export interface FeedbackSliceState {
  pendingFeedback: RenderingFeedback[];
  pendingAppProtocolResponses: AppProtocolResponseItem[];
  pendingAppInteractions: AppInteractionItem[];
  pendingAppEvents: AppEventItem[];
}

export interface FeedbackSliceActions {
  addRenderingFeedback: (feedback: RenderingFeedback) => void;
  consumePendingFeedback: () => RenderingFeedback[];
  addPendingAppProtocolResponse: (item: AppProtocolResponseItem) => void;
  consumePendingAppProtocolResponses: () => AppProtocolResponseItem[];
  addPendingAppInteraction: (item: AppInteractionItem) => void;
  consumePendingAppInteractions: () => AppInteractionItem[];
  addPendingAppEvent: (item: AppEventItem) => void;
  consumePendingAppEvents: () => AppEventItem[];
}

export type FeedbackSlice = FeedbackSliceState & FeedbackSliceActions;

export const createFeedbackSlice: SliceCreator<FeedbackSlice> = (set, get) => ({
  pendingFeedback: [],
  pendingAppProtocolResponses: [],
  pendingAppInteractions: [],
  pendingAppEvents: [],

  addRenderingFeedback: (feedback) =>
    set((state) => {
      state.pendingFeedback.push(feedback);
    }),

  consumePendingFeedback: createConsumeQueue(get, set, 'pendingFeedback'),

  addPendingAppProtocolResponse: (item) =>
    set((state) => {
      state.pendingAppProtocolResponses.push(item);
    }),

  consumePendingAppProtocolResponses: createConsumeQueue(get, set, 'pendingAppProtocolResponses'),

  addPendingAppInteraction: (item) =>
    set((state) => {
      state.pendingAppInteractions.push(item);
    }),

  consumePendingAppInteractions: createConsumeQueue(get, set, 'pendingAppInteractions'),

  addPendingAppEvent: (item) =>
    set((state) => {
      state.pendingAppEvents.push(item);
    }),

  consumePendingAppEvents: createConsumeQueue(get, set, 'pendingAppEvents'),
});
