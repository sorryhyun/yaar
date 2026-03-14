/**
 * Message status slice - tracks whether sent messages were accepted or queued.
 */
import type { SliceCreator, MessageStatusSlice } from '../types';

const STATUS_TTL_MS = 10_000;

export const createMessageStatusSlice: SliceCreator<MessageStatusSlice> = (set) => ({
  messageStatuses: {},

  trackMessage: (messageId) =>
    set((state) => {
      // Prune expired entries
      const now = Date.now();
      for (const [id, entry] of Object.entries(state.messageStatuses)) {
        if (now - entry.timestamp > STATUS_TTL_MS) {
          delete state.messageStatuses[id];
        }
      }
      state.messageStatuses[messageId] = { status: 'sent', timestamp: now };
    }),

  acceptMessage: (messageId, agentId) =>
    set((state) => {
      const entry = state.messageStatuses[messageId];
      if (entry) {
        entry.status = 'accepted';
        entry.agentId = agentId;
      }
    }),

  queueMessage: (messageId, position) =>
    set((state) => {
      const entry = state.messageStatuses[messageId];
      if (entry) {
        entry.status = 'queued';
        entry.position = position;
      } else {
        // May arrive before trackMessage if network is fast
        state.messageStatuses[messageId] = {
          status: 'queued',
          position,
          timestamp: Date.now(),
        };
      }
    }),

  clearMessageStatus: (messageId) =>
    set((state) => {
      delete state.messageStatuses[messageId];
    }),

  clearAllMessageStatuses: () =>
    set((state) => {
      state.messageStatuses = {};
    }),
});
