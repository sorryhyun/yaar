/**
 * Frames the (re)connect path sends on behalf of a hook. They live here rather than
 * beside the hooks that also send them so `connection.ts` does not depend on `hooks/`.
 */
import { useDesktopStore } from '@/store';
import { ClientEventType, type ClientEvent } from '@/types';
import type { SubscribeMonitorEvent } from '@yaar/shared';
import { settledViewport } from '@/lib/device';

/**
 * The one spelling of "this tab is looking at `monitorId`": which monitor, how big the
 * screen is, which shell layout it renders, and which way it is held. The server sizes
 * new windows from the viewport and tells the monitor agent it is on a phone (and turned
 * sideways) from the rest, so every send carries all of it — including the one on
 * (re)connect. The viewport is the keyboard-down one; see `settledViewport`.
 */
export function monitorSubscription(monitorId: string): SubscribeMonitorEvent {
  const { formFactor, orientation } = useDesktopStore.getState();
  return {
    type: ClientEventType.SUBSCRIBE_MONITOR,
    monitorId,
    viewport: settledViewport(),
    formFactor,
    orientation,
  };
}

/**
 * This tab's presence as one frame, for the (re)connect path.
 *
 * Presence is per connection and the server forgets it when the socket closes, so a
 * reconnecting tab has to say it again — a tab that reconnects while hidden, which is
 * exactly the tab this whole mechanism is about, would otherwise come back looking
 * present.
 */
export function clientPresence(): ClientEvent {
  return {
    type: ClientEventType.CLIENT_PRESENCE,
    state: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
  };
}
