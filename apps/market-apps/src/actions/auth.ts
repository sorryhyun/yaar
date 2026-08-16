// Publisher sign-in, against YAAR's own Google auth routes.

import { wait, withLoading } from '@bundled/yaar';
import { yaarGet, yaarPost } from '../api/index.js';
import { SIGNED_OUT_ACCOUNT } from '../constants.js';
import { AuthLoginSchema, AuthMeSchema, AuthStatusSchema } from '../schema.js';
import { account, authBusy, setAccount, setAuthBusy, setStatus } from '../store/index.js';

/** How long to keep polling for a consent screen to come back: ~5 min at 2s. */
const SIGN_IN_POLL_ATTEMPTS = 150;
const SIGN_IN_POLL_INTERVAL_MS = 2000;

/** Pull sign-in status + owned apps from the server into the `account` signal. */
export async function refreshAccount(): Promise<void> {
  try {
    const status = await yaarGet('/api/auth/google/status', AuthStatusSchema);

    let ownedApps: string[] = [];
    let email = status.email;
    if (status.signedIn) {
      // Best-effort: the marketplace may be unreachable — keep the local status either way.
      try {
        const me = await yaarGet('/api/auth/google/me', AuthMeSchema);
        ownedApps = Array.isArray(me.apps) ? me.apps : [];
        email = me.email ?? status.email;
      } catch {
        /* keep local status; owned apps unknown */
      }
    }

    setAccount({
      configured: status.configured,
      signedIn: status.signedIn,
      email,
      pending: status.pending,
      ownedApps,
    });
  } catch {
    // Not a system app, or the route is unavailable — leave the signed-out default.
    setAccount(SIGNED_OUT_ACCOUNT);
  }
}

/**
 * Start Google sign-in, then poll status until the browser round-trip finishes.
 *
 * Sign-in is a human gesture (agents publish against the already-signed-in
 * identity, they don't summon consent), so it lives on a button here and reports
 * back by polling rather than by holding the request open across the consent screen.
 */
export async function signIn(): Promise<void> {
  if (authBusy()) return;
  await withLoading(
    setAuthBusy,
    async () => {
      await yaarPost('/api/auth/google/login', AuthLoginSchema);
      setStatus('Complete sign-in in the browser window that just opened…', false);

      for (let i = 0; i < SIGN_IN_POLL_ATTEMPTS; i++) {
        await wait(SIGN_IN_POLL_INTERVAL_MS);
        await refreshAccount();
        const a = account();
        if (a.signedIn) {
          setStatus(`Signed in as ${a.email}`);
          return;
        }
        if (!a.pending) break; // the pending login was cancelled or swept
      }
      if (!account().signedIn) setStatus('Sign-in did not complete. Try again.');
    },
    (msg) => setStatus(`Sign-in failed: ${msg}`),
  );
}

export async function signOut(): Promise<void> {
  if (authBusy()) return;
  await withLoading(
    setAuthBusy,
    async () => {
      await yaarPost('/api/auth/google/logout');
      await refreshAccount();
      setStatus('Signed out');
    },
    (msg) => setStatus(`Sign-out failed: ${msg}`),
  );
}
