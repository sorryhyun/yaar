/**
 * Message status slice — what became of each message the user sent.
 *
 * Status is driven by *terminal events*, not by a clock. It used to be swept by a 10s TTL
 * evaluated lazily inside `trackMessage`, which meant an entry only aged out when the user
 * happened to send another message — and a message the server had silently dropped kept
 * its "queued" chip until then, or forever if they sent nothing else. Nothing ages out
 * here now: an entry leaves because something *happened* to it (accepted, queued, failed,
 * or the turn began), and one that never leaves is a bug worth seeing rather than one a
 * timer would have swept under the rug.
 */
import type { SliceCreator, MessageStatusSlice } from '../types';

export const createMessageStatusSlice: SliceCreator<MessageStatusSlice> = (set) => ({
  messageStatuses: {},

  trackMessage: (messageId, status = 'sent') =>
    set((state) => {
      state.messageStatuses[messageId] = { status, timestamp: Date.now() };
    }),

  acceptMessage: (messageId, agentId) =>
    set((state) => {
      const entry = state.messageStatuses[messageId];
      if (entry) {
        entry.status = 'accepted';
        entry.agentId = agentId;
        delete entry.error;
      } else {
        state.messageStatuses[messageId] = { status: 'accepted', agentId, timestamp: Date.now() };
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

  /**
   * The server says this message will not run.
   *
   * This is the transition that did not exist. Every server-side drop — a budget slot that
   * never freed, a full queue, an unknown monitor, a resetting pool — now names the message
   * it killed, and this is where that lands: the chip stops claiming the message is on its
   * way and says what became of it.
   */
  failMessage: (messageId, error) =>
    set((state) => {
      const entry = state.messageStatuses[messageId];
      if (entry) {
        entry.status = 'failed';
        entry.error = error;
        delete entry.position;
      } else {
        state.messageStatuses[messageId] = { status: 'failed', error, timestamp: Date.now() };
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
