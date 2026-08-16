import { withLoading } from '@bundled/yaar';
import { setLoading, setStatus } from '../store/index.js';

/**
 * Run an async action with loading state and unified error handling.
 * Sets status to `loadingMsg` before starting; on failure prefixes
 * the error with `errorPrefix`.
 *
 * Every user-initiated action in this folder goes through here, which is what
 * keeps the spinner and the status line agreeing about whether work is in flight.
 * The two exceptions document themselves: `confirmPublish` drives the dialog's own
 * busy flag, and `refreshGithubStatus` is ambient and must stay silent.
 */
export async function runAction(
  loadingMsg: string,
  action: () => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  setStatus(loadingMsg, false);
  await withLoading(setLoading, action, (msg) => setStatus(`${errorPrefix}: ${msg}`));
}
