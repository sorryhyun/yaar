// The GitHub health hint behind the publish banner.

import { fetchGithubStatus } from '../api/index.js';
import { GITHUB_STATUS_HEALTHY, GITHUB_STATUS_POLL_MS } from '../constants.js';
import { parseGithubStatus } from '../parsers/index.js';
import { setGithubStatus } from '../store/index.js';

/**
 * Refresh the GitHub health hint behind the publish banner.
 *
 * Deliberately silent: it does not go through `runAction`, does not touch
 * `statusText`, and swallows its own errors. This is ambient context, not a user
 * action — if the status page is unreachable (offline, blocked domain, rate
 * limited) the honest UI is no banner, not an error about a health check.
 */
export async function refreshGithubStatus(): Promise<void> {
  try {
    setGithubStatus(parseGithubStatus(await fetchGithubStatus()));
  } catch {
    // Can't tell — fall back to silence rather than guessing at an outage.
    setGithubStatus(GITHUB_STATUS_HEALTHY);
  }
}

/**
 * Poll while the window lives; returns the stop thunk for `onCleanup`.
 *
 * Tied to the window rather than the server so the request stops the moment the
 * user closes Market Apps — nothing polls GitHub in the background.
 */
export function startGithubStatusPolling(): () => void {
  void refreshGithubStatus();
  const timer = setInterval(() => void refreshGithubStatus(), GITHUB_STATUS_POLL_MS);
  return () => clearInterval(timer);
}