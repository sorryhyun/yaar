export {};

// The four control actions behind the row buttons and the protocol commands.
//
// Each one re-fetches only the list it touched. The subscription would push the
// same change a moment later, but refreshing here keeps the row from lingering if
// the ping is lost.

import { del, invoke, tryToast } from '@bundled/yaar';
import { agentUri, windowUri } from './constants';
import { fetchAgents, fetchWindows } from './fetchers';
import { appProcesses, markRefreshed } from './store';

/**
 * Run a control action with a success toast, then re-read the list it affected
 * and stamp the refresh time. Failures surface as a toast from `tryToast` and
 * deliberately skip the re-fetch: nothing changed, so nothing needs re-reading.
 */
async function act(run: () => Promise<unknown>, success: string, reload: () => Promise<void>) {
  await tryToast(run, { success });
  await reload();
  markRefreshed();
}

export async function interruptAgent(agentId: string) {
  await act(
    () => invoke(agentUri(agentId), { action: 'interrupt' }),
    `Interrupted ${agentId}`,
    fetchAgents,
  );
}

export async function closeWindow(windowId: string) {
  await act(() => del(windowUri(windowId)), 'Closed window', fetchWindows);
}

/**
 * Kill an app's agent, freeing its slot and dropping its context. The app itself
 * stays installed and its windows stay open — the next interaction spawns a fresh
 * agent. This is the only way to reclaim an orphaned agent.
 *
 * Note the URI: an app agent is addressed by its appId, in the same roster
 * namespace as {@link interruptAgent}'s instance id.
 */
export async function killAppAgent(appId: string) {
  await act(() => del(agentUri(appId)), `Killed ${appId} agent`, fetchAgents);
}

/** Close every open window belonging to an app. Leaves the app agent alone. */
export async function closeAppWindows(appId: string) {
  const targets = appProcesses().find((p) => p.appId === appId)?.windows ?? [];
  if (targets.length === 0) return;

  await act(
    () => Promise.all(targets.map((w) => del(windowUri(w.id)))),
    `Closed ${targets.length} window${targets.length === 1 ? '' : 's'}`,
    fetchWindows,
  );
}
