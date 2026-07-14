/**
 * Outbox slice — the commands this client has taken responsibility for delivering.
 *
 * A user message used to be fire-and-forget: `send()` returned nothing, and if the socket
 * happened to be closed it logged a warning and dropped the event on the floor — *after*
 * the UI had already minted a message id, written the message into the CLI panel, and
 * consumed the drawing and attached images. The command was gone, its attachments were
 * gone, and the transcript said it had been sent. There was no worse failure in the app:
 * it lied in the user's own record of what they had asked for.
 *
 * So a message that requires delivery is held here until the server acknowledges it —
 * `MESSAGE_ACCEPTED` or `MESSAGE_QUEUED` (the server has it) or `ERROR` naming it (the
 * server refused it). Anything still in the outbox has *not* been accepted, whatever the
 * socket looked like at the time, and is resent on reconnect. The whole event is held,
 * attachments and all, so a retry carries the drawing that a bare re-type could not.
 *
 * Resending is safe because the server dedups by message id (`LiveSession.acceptedMessageIds`):
 * a message that did land before the socket died is acked again rather than run twice.
 */
import type { SliceCreator, OutboxSlice } from '../types';

export const createOutboxSlice: SliceCreator<OutboxSlice> = (set, get) => ({
  outbox: [],

  enqueueOutbox: (messageId, event) =>
    set((state) => {
      state.outbox.push({ messageId, event, queuedAt: Date.now() });
    }),

  /** The server has taken (or refused) this message — stop holding it. */
  settleOutbox: (messageId) =>
    set((state) => {
      state.outbox = state.outbox.filter((entry) => entry.messageId !== messageId);
    }),

  /** Everything still unacknowledged, oldest first — the resend list. */
  pendingOutbox: () => get().outbox,

  clearOutbox: () =>
    set((state) => {
      state.outbox = [];
    }),
});
