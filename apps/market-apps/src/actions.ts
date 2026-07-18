// ── Business logic / actions ───────────────────────────────────────────
//
// User-facing operations that orchestrate the store (state) and api (I/O)
// layers: refresh, install, uninstall, publish, and the Google publisher
// sign-in flow. Each wraps its I/O in runAction for uniform loading + error
// handling so the components stay declarative.

import { errMsg } from '@bundled/yaar';
import { SIGNED_OUT_ACCOUNT } from './constants.js';
import {
  apiGet,
  hostDelete,
  hostInstall,
  hostListInstalled,
  hostPublish,
  yaarGet,
  yaarPost,
} from './api.js';
import {
  account,
  apiBase,
  authBusy,
  hasInstalled,
  markInstalledSignal,
  setAccount,
  setAuthBusy,
  setInstalledApps,
  setLoading,
  setMarketApps,
  setStatus,
} from './store.js';
import { parseMarket } from './parsers.js';
import type { ApiPayload, ListedApp } from './types.js';

// ── Async action runner ──────────────────────────────────────────────

/**
 * Run an async action with loading state and unified error handling.
 * Sets status to `loadingMsg` before starting; on failure prefixes
 * the error with `errorPrefix`.
 */
export async function runAction(
  loadingMsg: string,
  action: () => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  setLoading(true);
  setStatus(loadingMsg, false);
  try {
    await action();
  } catch (err: unknown) {
    setStatus(`${errorPrefix}: ${errMsg(err)}`);
  } finally {
    setLoading(false);
  }
}

// ── Marketplace data ───────────────────────────────────────────────

export async function refreshData(): Promise<void> {
  if (!apiBase()) {
    setStatus('No domain configured. Use App Protocol command setDomain.', true);
    return;
  }
  await runAction(
    'Refreshing…',
    async () => {
      const marketPayload = await apiGet<ApiPayload>('/api/apps/');
      const apps = parseMarket(marketPayload);

      try {
        const localInstalled = await hostListInstalled();
        setInstalledApps(localInstalled);
        setStatus(`Loaded ${apps.length} market / ${localInstalled.length} installed apps`);
      } catch {
        setInstalledApps([]);
        setStatus(`Loaded ${apps.length} market apps (installed list unavailable)`);
      }

      setMarketApps(apps.map((m) => ({ ...m, installed: hasInstalled(m.id) })));
    },
    'Refresh failed',
  );
}

export async function installApp(app: ListedApp): Promise<void> {
  await runAction(
    `Installing ${app.name}…`,
    async () => {
      await hostInstall(app);
      markInstalledSignal(app, true);
      setStatus(`Installed ${app.name}`);
    },
    'Install failed',
  );
}

export async function uninstallApp(app: { id: string; name: string }): Promise<void> {
  await runAction(
    `Uninstalling ${app.name}…`,
    async () => {
      await hostDelete(app);
      markInstalledSignal(app, false);
      setStatus(`Uninstalled ${app.name}`);
    },
    'Uninstall failed',
  );
}

export async function publishApp(app: { id: string; name: string }): Promise<void> {
  await runAction(
    `Publishing ${app.name}…`,
    async () => {
      const result = await hostPublish(app);
      setStatus(result?.message || `Published ${app.name}`);
      // Ownership may have just been claimed — refresh so the badge reflects it.
      await refreshAccount();
    },
    'Publish failed',
  );
}

// ── Publisher sign-in ───────────────────────────────────────────────

/** Pull sign-in status + owned apps from the server into the `account` signal. */
export async function refreshAccount(): Promise<void> {
  try {
    const status = await yaarGet<{
      configured: boolean;
      signedIn: boolean;
      email: string | null;
      pending: boolean;
    }>('/api/auth/google/status');

    let ownedApps: string[] = [];
    let email = status.email;
    if (status.signedIn) {
      // Best-effort: the marketplace may be unreachable — keep the local status either way.
      try {
        const me = await yaarGet<{ email: string | null; apps: string[] }>('/api/auth/google/me');
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
  setAuthBusy(true);
  try {
    await yaarPost<{ authUrl: string }>('/api/auth/google/login');
    setStatus('Complete sign-in in the browser window that just opened…', false);

    for (let i = 0; i < 150; i++) {
      // ~5 min ceiling at 2s
      await new Promise((r) => setTimeout(r, 2000));
      await refreshAccount();
      const a = account();
      if (a.signedIn) {
        setStatus(`Signed in as ${a.email}`);
        return;
      }
      if (!a.pending) break; // the pending login was cancelled or swept
    }
    if (!account().signedIn) setStatus('Sign-in did not complete. Try again.');
  } catch (err: unknown) {
    setStatus(`Sign-in failed: ${errMsg(err)}`);
  } finally {
    setAuthBusy(false);
  }
}

export async function signOut(): Promise<void> {
  if (authBusy()) return;
  setAuthBusy(true);
  try {
    await yaarPost('/api/auth/google/logout');
    await refreshAccount();
    setStatus('Signed out');
  } catch (err: unknown) {
    setStatus(`Sign-out failed: ${errMsg(err)}`);
  } finally {
    setAuthBusy(false);
  }
}