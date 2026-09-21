import { useEffect, useRef } from 'react';
import { ClientEventType } from '@/types';
import type { ClientPresenceState } from '@yaar/shared';
import { wsManager, sendEvent } from '@/lib/transport/transport-manager';

/**
 * How long a tab must have been away before coming back is worth a resync.
 *
 * Under this, nothing can have gone wrong: a flick to another app and straight back
 * leaves every in-flight wait still inside its own deadline, and a resync would replace
 * the desktop from a snapshot for no reason. Above it, a wait may well have expired
 * against a page that was not running, and the cheap fix is to ask what is actually
 * there.
 *
 * The *reliable* signal is the Page Lifecycle `resume` event, which fires only when the
 * browser really did stop running us; this threshold is the fallback for the browsers and
 * platforms that freeze a tab without ever saying so.
 */
const RESYNC_AFTER_HIDDEN_MS = 5_000;

/**
 * Tell the server when this tab stops being able to answer, and put it back together
 * when it can again.
 *
 * Two jobs, one listener set, because they are the same event:
 *
 * 1. **Report.** An open socket is not a live desktop — a backgrounded tab keeps its
 *    WebSocket while running no script at all, so the server goes on addressing a page
 *    that cannot hear it and every wait against it expires blaming the app. The frame
 *    this sends is what lets those timeouts name the real cause instead.
 *
 * 2. **Recover.** Today the only thing that rebuilds state is the socket closing, which
 *    is the browser's discretion, not ours: a tab frozen for four minutes was observed
 *    keeping its socket open the whole time and only dropping it *after* being resumed.
 *    A freeze shorter than that resumes onto a live socket the server may already have
 *    given up talking to, and nothing was ever going to notice. So coming back is its
 *    own trigger, on the same path a reconnect uses.
 *
 * `visibilitychange` is the portable signal and fires *before* a freeze, which is what
 * makes the report arrive at all; `freeze`/`resume` are the exact ones where offered.
 * The report is best-effort by nature — a tab killed outright says nothing — and the
 * server treats the absence of news as "no news", never as away.
 */
export function useClientPresence(recover: () => void) {
  // Held in a ref so the listeners below can be installed once, for the lifetime of the
  // connection, without re-subscribing every time the callback identity changes.
  const recoverRef = useRef(recover);
  recoverRef.current = recover;

  useEffect(() => {
    let hiddenSince: number | null = null;

    const report = (state: ClientPresenceState) => {
      // Straight to the socket: this describes the transport's own peer, and a frame
      // that cannot be delivered has nothing to say. A closed socket means the server
      // already knows more than this would have told it.
      if (wsManager.ws?.readyState !== WebSocket.OPEN) return;
      sendEvent(wsManager, { type: ClientEventType.CLIENT_PRESENCE, state });
    };

    const goneAway = (state: ClientPresenceState) => {
      hiddenSince ??= Date.now();
      report(state);
    };

    /** @param forced true when the browser told us it had actually stopped us. */
    const cameBack = (forced: boolean) => {
      const away = hiddenSince === null ? 0 : Date.now() - hiddenSince;
      hiddenSince = null;
      report('visible');
      if (forced || away >= RESYNC_AFTER_HIDDEN_MS) recoverRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') goneAway('hidden');
      else cameBack(false);
    };
    const onFreeze = () => goneAway('frozen');
    const onResume = () => cameBack(true);

    document.addEventListener('visibilitychange', onVisibility);
    // Not on every browser; `addEventListener` for an unknown name is a no-op, so no guard.
    window.addEventListener('freeze', onFreeze);
    window.addEventListener('resume', onResume);

    // Say where we stand now, rather than waiting for the first change. A tab that
    // connects while already hidden — restored on startup, opened in the background —
    // would otherwise be indistinguishable from one nobody has heard from.
    if (document.visibilityState === 'hidden') goneAway('hidden');

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('freeze', onFreeze);
      window.removeEventListener('resume', onResume);
    };
  }, []);
}
