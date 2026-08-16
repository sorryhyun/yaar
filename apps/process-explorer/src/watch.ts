export {};

// Mount-time wiring: the subscriptions, the stream reconciler and the freshness
// clock, each with its own cleanup. Called once from the root component.

import { createEffect, onCleanup } from '@bundled/solid-js';
import { showToast, subscribe } from '@bundled/yaar';
import { CLOCK_INTERVAL_MS, LOG_PREFIX, URI } from './constants';
import { fetchAgents, fetchWindows, refreshAll } from './fetchers';
import { agentList, markRefreshed, setNow } from './store';
import { reconcileStreams, stopAllStreams } from './streams';

/**
 * Subscribe to a resource, re-running `onChange` on every pushed change, and
 * tear the subscription down on unmount — including the race where the component
 * unmounts before `subscribe()` has resolved.
 */
function watch(uri: string, onChange: () => void) {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  subscribe(uri, () => {
    void onChange();
    markRefreshed();
  })
    .then((unsub) => {
      // Unmounted before the subscription landed — drop it immediately.
      if (cancelled) unsub();
      else unsubscribe = unsub;
    })
    .catch((err) => {
      // Reported once, at mount: unlike the fetchers this cannot retry itself.
      console.error(`${LOG_PREFIX} subscribe(${uri}) failed`, err);
      showToast(`Live updates unavailable for ${uri}`, 'error');
    });

  onCleanup(() => {
    cancelled = true;
    unsubscribe?.();
  });
}

/**
 * Subscribe rather than poll. The server pushes a change ping whenever an agent is
 * created, disposed, or flips busy/idle, and on every window.* action — so a quiet
 * desktop costs nothing and a busy one updates as it happens.
 *
 * The apps view needs no subscription of its own: it is derived from these same two
 * lists, so it re-renders whenever either is pushed.
 */
export function startWatching() {
  refreshAll();

  watch(URI.agents, fetchAgents);
  watch(URI.windows, fetchWindows);

  // Live activity: the subscription set is derived from agentList(), so an agent
  // that appears gets a stream and one that disappears has it torn down.
  createEffect(() => reconcileStreams(agentList()));
  onCleanup(stopAllStreams);

  // Freshness is the one readout that changes with no frame arriving — "3s ago"
  // has to become "4s ago" on its own — so it needs a clock of its own.
  const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
  onCleanup(() => clearInterval(clock));
}
