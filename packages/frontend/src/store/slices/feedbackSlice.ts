/**
 * Feedback slice - manages rendering feedback for the server.
 */
import type { SliceCreator, FeedbackSlice } from '../types';
import { createConsumeQueue } from '../helpers';

export const createFeedbackSlice: SliceCreator<FeedbackSlice> = (set, get) => ({
  pendingFeedback: [],
  pendingAppProtocolResponses: [],
  pendingAppInteractions: [],

  addRenderingFeedback: (feedback) =>
    set((state) => {
      state.pendingFeedback.push(feedback);
    }),

  addPendingFeedback: (feedback) =>
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
});
