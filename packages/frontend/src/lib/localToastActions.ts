/**
 * Client-side toast actions.
 *
 * A toast's `action` normally carries an `eventId` that the server minted and is
 * waiting to hear back about (`sendToastAction`). Toasts the frontend raises on
 * its own — "couldn't open this app, Retry" — have no such server-side event; the
 * button has to run a local callback instead. Callers register the handler here
 * under the same eventId they put on the toast, and the toast container tries the
 * registry before falling back to the WebSocket.
 *
 * Handlers are one-shot: they are removed once run, and re-registering the same
 * eventId replaces the previous handler.
 */
const handlers = new Map<string, () => void>();

/** Register a handler for `eventId`. Returns a disposer for unmount cleanup. */
export function registerLocalToastAction(eventId: string, handler: () => void): () => void {
  handlers.set(eventId, handler);
  return () => {
    if (handlers.get(eventId) === handler) handlers.delete(eventId);
  };
}

/**
 * Run the handler for `eventId` if one is registered.
 * @returns true if a local handler ran (so the caller should not notify the server).
 */
export function runLocalToastAction(eventId: string): boolean {
  const handler = handlers.get(eventId);
  if (!handler) return false;
  handlers.delete(eventId);
  handler();
  return true;
}

/** Test helper — drops every registered handler. */
export function clearLocalToastActions(): void {
  handlers.clear();
}
