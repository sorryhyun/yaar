// Loading the catalog, and the two actions that change what is on this machine.

import { showConfirm } from '@bundled/yaar';
import { apiGet, hostDelete, hostInstall, hostListInstalled } from '../api/index.js';
import { parseMarket } from '../parsers/index.js';
import { MarketPayloadSchema } from '../schema.js';
import {
  hasInstalled,
  installedVersionOf,
  markInstalledSignal,
  ownsApp,
  reconcileInstalledApps,
  recordMarketplaceInstall,
  setMarketApps,
  setStatus,
} from '../store/index.js';
import type { ListedApp } from '../types.js';
import { runAction } from './run-action.js';

export async function refreshData(): Promise<void> {
  await runAction(
    'Refreshing…',
    async () => {
      // Remember when this refresh began. A list response started before a
      // successful install must not erase that install when it arrives late.
      const refreshStartedAt = Date.now();
      // No trailing slash: the catalog route is `GET /api/apps`, and the slashed
      // form only reaches it through a 307 that costs a second round trip and
      // depends on the marketplace rebuilding the URL correctly.
      const marketPayload = await apiGet('/api/apps', MarketPayloadSchema);
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