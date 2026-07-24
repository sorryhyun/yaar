// ── Business logic / actions ───────────────────────────────────────────
//
// User-facing operations that orchestrate the store (state) and api (I/O)
// layers: refresh, install, uninstall, publish, and the Google publisher
// sign-in flow. Each wraps its I/O in runAction for uniform loading + error
// handling so the components stay declarative.

import { showConfirm, wait, withLoading } from '@bundled/yaar';
import { SIGNED_OUT_ACCOUNT, GITHUB_STATUS_HEALTHY, GITHUB_STATUS_POLL_MS } from './constants.js';
import {
  apiGet,
  fetchGithubStatus,
  hostCancelPublish,
  hostConfirmPublish,
  hostDelete,
  hostInstall,
  hostListInstalled,
  hostPreparePublish,
  yaarGet,
  yaarPost,
} from './api.js';
import {
  account,
  authBusy,
  hasInstalled,
  installedVersionOf,
  markInstalledSignal,
  ownsApp,
  reconcileInstalledApps,
  recordMarketplaceInstall,
  pendingPublish,
  setAccount,
  setAuthBusy,
  setConfirmBusy,
  setGithubStatus,
  setLoading,
  setMarketApps,
  setPendingPublish,
  setStatus,
} from './store.js';
import { parseGithubStatus, parseMarket } from './parsers.js';
import { AuthLoginSchema, AuthMeSchema, AuthStatusSchema, MarketPayloadSchema } from './schema.js';
import type { ListedApp } from './types.js';

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
  setStatus(loadingMsg, false);
  await withLoading(setLoading, action, (msg) => setStatus(`${errorPrefix}: ${msg}`));
}

// ── Marketplace data ───────────────────────────────────────────────

export async function refreshData(): Promise<void> {
  await runAction(
    'Refreshing…',
    async () => {
      // Remember when this refresh began. A list response started before a
      // successful install must not erase that install when it arrives late.
      const refreshStartedAt = Date.now();
      const marketPayload = await apiGet('/api/apps/', MarketPayloadSchema);
      const apps = parseMarket(marketPayload);

      try {
        const localInstalled = await hostListInstalled();
        reconcileInstalledApps(localInstalled, refreshStartedAt);
        setStatus(`Loaded ${apps.length} market / ${localInstalled.length} installed apps`);
      } catch {
        // A thrown list read is not evidence that nothing is installed, so it is
        // not reconciled against: an empty authoritative list would clear every
        // installed card and retire the optimistic install records as "absent"
        // on what may be a transient host hiccup. Keep the last known list and
        // say the read failed.
        setStatus(`Loaded ${apps.length} market apps (installed list unavailable)`);
      }

      setMarketApps(apps.map((m) => ({ ...m, installed: hasInstalled(m.id) })));
    },
    'Refresh failed',
  );
}

/** Silently reconcile the optimistic install with the host's authoritative list. */
async function reconcileInstalledFromHost(): Promise<void> {
  const requestStartedAt = Date.now();
  try {
    reconcileInstalledApps(await hostListInstalled(), requestStartedAt);
  } catch {
    // The successful install remains optimistically current through the grace
    // period; a normal refresh will retry authoritative reconciliation later.
  }
}

/**
 * Ask before an install that lands on top of an app already on this machine.
 *
 * Installing over an existing app *replaces its directory* — the host deletes the
 * old one and unpacks the download in its place, it does not merge. For an app the
 * user develops or publishes locally, that directory is their source, including
 * edits they never pushed. The host also skips its own permission prompt when it
 * recognises the install as an update, so this dialog is the only thing between a
 * mis-click on "Install update" and unrecoverable local work.
 *
 * Fresh installs are not asked about — there is nothing to overwrite.
 */
async function confirmReplaceInstall(app: ListedApp): Promise<boolean> {
  const local = installedVersionOf(app.id);
  const versions = local && app.version ? ` (v${local} → v${app.version})` : '';
  const owned = ownsApp(app.id)
    ? ' You publish this app — publish your local version first if you want to keep it.'
    : '';
  return showConfirm(
    `Installing ${app.name}${versions} replaces the copy on this machine. Its local ` +
      `files are deleted, not merged — including any edits you have not published.${owned}`,
    {
      title: `Replace ${app.name}?`,
      okLabel: 'Replace',
      cancelLabel: 'Cancel',
      danger: true,
    },
  );
}

export async function installApp(app: ListedApp): Promise<void> {
  // Outside runAction: the dialog can sit open indefinitely, and a spinner plus a
  // disabled UI behind a modal asking a question is a deadlock, not a loading state.
  if (hasInstalled(app.id) && !(await confirmReplaceInstall(app))) {
    setStatus(`Install of ${app.name} cancelled`);
    return;
  }

  await runAction(
    `Installing ${app.name}…`,
    async () => {
      await hostInstall(app);
      // The host list can lag this result or omit version metadata. Save the
      // exact catalog version synchronously so an owned app is current now,
      // not spuriously labelled "Publish update" until a later refresh.
      recordMarketplaceInstall(app);
      void reconcileInstalledFromHost();
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

/**
 * Phase 1: package + freeze the app on the host and open the confirmation dialog.
 * A not-newer version is refused *here* (the host throws) before any dialog opens,
 * so `runAction`'s catch surfaces "bump the version" as the publish's failure.
 */
export async function publishApp(app: { id: string; name: string }): Promise<void> {
  await runAction(
    `Preparing ${app.name} to publish…`,
    async () => {
      const summary = await hostPreparePublish(app);
      setPendingPublish({ app, summary });
      setStatus(`Review ${app.name} v${summary.version ?? '?'} before publishing.`);
    },
    'Prepare to publish failed',
  );
}

/**
 * Phase 2: confirm the open publication. `acknowledgeDrift` ships the frozen
 * snapshot even though the source changed since prepare; the dialog only sets it on
 * the second, "Publish anyway" press. A first drift reply re-opens the dialog with
 * the changed-file list instead of uploading.
 */
export async function confirmPublish(acknowledgeDrift = false): Promise<void> {
  const pending = pendingPublish();
  if (!pending) return;

  setStatus(`Publishing ${pending.app.name}…`, false);
  await withLoading(
    setConfirmBusy,
    async () => {
      const outcome = await hostConfirmPublish(
        pending.app,
        pending.summary.publicationId,
        acknowledgeDrift,
      );
      if (outcome.published) {
        setPendingPublish(null);
        setStatus(outcome.message || `Published ${pending.app.name} to the marketplace`);
        // Ownership may have just been claimed — refresh so the badge reflects it.
        await refreshAccount();
      } else if (outcome.status === 'drift_detected') {
        setPendingPublish({
          ...pending,
          drift: { changedFiles: outcome.drift?.changedFiles ?? [] },
        });
        setStatus('Source changed since prepare — review the changes.');
      } else {
        // expired / not_found / error: the freeze is gone or unusable — close and report.
        setPendingPublish(null);
        setStatus(outcome.message || 'Publish failed.');
      }
    },
    (msg) => setStatus(`Publish failed: ${msg}`),
  );
}

/** Dismiss the dialog and discard the host-side freeze (best-effort — it also expires). */
export async function cancelPublish(): Promise<void> {
  const pending = pendingPublish();
  setPendingPublish(null);
  if (!pending) return;
  try {
    await hostCancelPublish(pending.app, pending.summary.publicationId);
  } catch {
    /* best-effort: the frozen bytes are swept on TTL expiry regardless */
  }
  setStatus('Publish cancelled.');
}

// ── Publisher sign-in ───────────────────────────────────────────────

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

      for (let i = 0; i < 150; i++) {
        // ~5 min ceiling at 2s
        await wait(2000);
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

// ── GitHub health polling ────────────────────────────────────────────

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
