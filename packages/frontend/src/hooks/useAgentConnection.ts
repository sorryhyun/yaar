/**
 * The agent connection's React surface — all two hooks of it.
 *
 * There is one WebSocket, so there is one owner: `useAgentConnectionOwner` is mounted
 * exactly once, by `DesktopSurface`, and everything else imports the outbound command it
 * wants as a plain function. It used to be a single `useAgentConnection()` that five
 * live components called, each installing its own `visibilitychange`/`freeze`/`resume`
 * and `resize` listeners and its own store subscriptions against the same singleton.
 *
 * `connection.ts` owns the socket; `commands.ts` owns what we say into it.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useDesktopStore } from '@/store';
import { wsManager } from '@/lib/transport/transport-manager';
import { connect, recoverAfterResume } from '@/lib/transport/connection';
import { send, sendComponentAction } from '@/lib/transport/commands';
import { usePendingEventDrainer } from './use-agent-connection/usePendingEventDrainer';
import { useMonitorSync } from './use-agent-connection/useMonitorSync';
import { useClientPresence } from './use-agent-connection/useClientPresence';

export {
  send,
  sendMessage,
  sendWindowMessage,
  sendComponentAction,
  sendDialogFeedback,
  sendToastAction,
  sendUserPromptResponse,
  interrupt,
  interruptAgent,
  reset,
  flushPending,
  resync,
} from '@/lib/transport/commands';
export { connect, disconnect, retryConnection } from '@/lib/transport/connection';

// Hoisted so `useSyncExternalStore` is handed the same two functions on every render.
// As inline arrows they made React tear down and reinstall the subscription per render,
// in a component that re-renders per keystroke.
const subscribeToSocket = (cb: () => void) => wsManager.subscribe(cb);
const socketSnapshot = () => wsManager.getSnapshot();
const socketServerSnapshot = () => false;

/** Whether the transport is open. Safe to call from anywhere; subscribes to nothing else. */
export function useIsConnected(): boolean {
  return useSyncExternalStore(subscribeToSocket, socketSnapshot, socketServerSnapshot);
}

/**
 * Open the connection and keep it in step with the desktop. **Mount exactly once.**
 *
 * The three sub-hooks below each install global listeners or store subscriptions against
 * the one socket, so a second mount does not add redundancy, it adds duplicate frames:
 * a second `CLIENT_PRESENCE` per backgrounding, a second `RESYNC` per resume (and so a
 * second authoritative `SNAPSHOT` replacing desktop state), a second `SUBSCRIBE_MONITOR`
 * per monitor switch, and a second full walk of the window map per streamed token.
 */
export function useAgentConnectionOwner(): void {
  useEffect(() => {
    connect();
  }, []);

  useClientPresence(recoverAfterResume);

  usePendingEventDrainer({
    send,
    sendComponentAction,
    addCliEntry: useDesktopStore.getState().addCliEntry,
  });
  useMonitorSync();
}
