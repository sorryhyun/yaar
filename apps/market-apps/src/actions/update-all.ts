// Bulk update: install the marketplace version of every installed app that is behind
// it, one at a time. Single-app install lives in catalog.ts; this file is only the
// batch around it, and it reuses that file's host call and reconciliation.

import { showConfirm } from '@bundled/yaar';
import { hostInstall } from '../api/index.js';
import {
  installedVersionOf,
  outdatedApps,
  recordMarketplaceInstall,
  setStatus,
  setUpdateRun,
} from '../store/index.js';
import type { DisplayApp, UpdateOutcome } from '../types.js';
import { reconcileInstalledFromHost } from './catalog.js';
import { runAction } from './run-action.js';

/** Why a call to `updateAllApps` did nothing. Absent when a run actually started. */
export type UpdateAllRefusal = 'none-outdated' | 'already-running' | 'cancelled';

export type UpdateAllSummary = {
  started: boolean;
  reason?: UpdateAllRefusal;
  updated: number;
  failed: number;
  results: UpdateOutcome[];
};

function refused(reason: UpdateAllRefusal): UpdateAllSummary {
  return { started: false, reason, updated: 0, failed: 0, results: [] };
}

/**
 * The concurrency guard, held for the whole call — confirmation dialog included.
 *
 * A plain variable rather than `updateRun().active`: that flag is only raised once the
 * run reaches its first app, which is several awaits in, and a guard that can be
 * passed twice before it is set does not guard anything. It also covers the open
 * dialog, so a second press behind the modal cannot start a parallel run.
 */
let runInFlight = false;

/** Host rejections arrive as Errors; anything else is stringified rather than dropped. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function versionArrow(app: DisplayApp): string {
  const local = installedVersionOf(app.id);
  return local && app.version ? `${app.name} v${local} → v${app.version}` : app.name;
}

/**
 * One confirmation for the whole batch, asked before anything is installed.
 *
 * Every app here is being installed *over* an existing copy, which is the case
 * `confirmReplaceInstall` in catalog.ts exists for: the host deletes the old
 * directory rather than merging, so unpublished local edits go with it. Asking once
 * per app instead would put a modal between every step of a run whose whole point is
 * that it does not stop.
 */
async function confirmUpdateAll(apps: DisplayApp[]): Promise<boolean> {
  return showConfirm(
    `Updating ${apps.length} app${apps.length === 1 ? '' : 's'} replaces each installed ` +
      `copy with the marketplace version. Local files are deleted, not merged — ` +
      `including any edits you have not published. ${apps.map(versionArrow).join(', ')}.`,
    {
      title: `Update ${apps.length} app${apps.length === 1 ? '' : 's'}?`,
      okLabel: 'Update All',
      cancelLabel: 'Cancel',
      danger: true,
    },
  );
}

/**
 * Install every outdated app, sequentially, reporting progress as it goes.
 *
 * Sequential rather than parallel because each install is the host unpacking a
 * directory, and the status line has room for one answer at a time.
 *
 * A single app's failure is recorded and stepped over — a batch that aborts on the
 * first refusal leaves the remaining apps stale with nothing on screen saying so.
 * The summary at the end names what failed.
 *
 * `confirm` is what the header button passes; the protocol command defaults it off,
 * since an agent calling `updateAll` has already been told to update.
 */
export async function updateAllApps(
  options: { confirm?: boolean } = {},
): Promise<UpdateAllSummary> {
  if (runInFlight) return refused('already-running');

  const targets = outdatedApps();
  if (targets.length === 0) {
    setStatus('Everything is up to date');
    return refused('none-outdated');
  }

  runInFlight = true;
  try {
    return await runUpdates(targets, options.confirm === true);
  } finally {
    runInFlight = false;
  }
}

/** The run itself, entered only with `runInFlight` held. */
async function runUpdates(targets: DisplayApp[], confirm: boolean): Promise<UpdateAllSummary> {
  // Outside the run for the reason installApp's own dialog is outside runAction: a
  // modal asking a question in front of a disabled UI and a spinner is a deadlock.
  if (confirm && !(await confirmUpdateAll(targets))) {
    setStatus('Update cancelled');
    return refused('cancelled');
  }

  const results: UpdateOutcome[] = [];
  const total = targets.length;

  await runAction(
    `Updating ${total} apps…`,
    async () => {
      try {
        for (const [index, app] of targets.entries()) {
          setUpdateRun({
            active: true,
            total,
            completed: index,
            current: app.name,
            results: [...results],
          });
          // No stamp: the timestamp belongs to the finished run, not to each step.
          setStatus(`Updating ${app.name} (${index + 1}/${total})…`, false);

          const from = installedVersionOf(app.id);
          try {
            await hostInstall(app);
            // Same call catalog.ts makes after a single install: it records the
            // catalog version synchronously, so this app drops out of
            // `outdatedApps` now rather than at the next host list read.
            recordMarketplaceInstall(app);
            results.push({
              id: app.id,
              name: app.name,
              ...(from ? { from } : {}),
              ...(app.version ? { to: app.version } : {}),
              ok: true,
            });
          } catch (error) {
            results.push({
              id: app.id,
              name: app.name,
              ...(from ? { from } : {}),
              ...(app.version ? { to: app.version } : {}),
              ok: false,
              error: messageOf(error),
            });
          }
        }
      } finally {
        // In a finally so that an unexpected throw cannot leave `active` true, which
        // would refuse every later run for the lifetime of the window.
        setUpdateRun({
          active: false,
          total,
          completed: results.length,
          current: null,
          results: [...results],
        });
      }
    },
    'Update All failed',
  );

  await reconcileInstalledFromHost();

  const updated = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  setStatus(
    failures.length
      ? `Updated ${updated} of ${total} apps — failed: ${failures.map((f) => `${f.name} (${f.error})`).join(', ')}`
      : `Updated ${updated} app${updated === 1 ? '' : 's'}`,
  );
  return { started: true, updated, failed: failures.length, results };
}
