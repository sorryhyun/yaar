// The two-phase publish flow: prepare + freeze, then confirm or cancel.

import { withLoading } from '@bundled/yaar';
import { hostCancelPublish, hostConfirmPublish, hostPreparePublish } from '../api/index.js';
import { normalizeId } from '../parsers/index.js';
import {
  account,
  installedApps,
  pendingPublish,
  publishRun,
  setConfirmBusy,
  setLastPublish,
  setPendingPublish,
  setSharedLastPublish,
  setStatus,
  setTermsAgreed,
  termsAgreed,
} from '../store/index.js';
import type { PublishResult } from '../types.js';
import { refreshAccount } from './auth.js';
import { runAction } from './run-action.js';

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
      // Every dialog starts unticked, even if the last one was ticked and cancelled.
      setTermsAgreed(false);
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
 *
 * The publisher terms ride along the same call: when this publisher has not yet
 * accepted the current version, the ticked box sends `acceptTermsVersion` and the
 * host records it before uploading. The dialog's button is disabled until then, so
 * a `terms_required` reply means the host refused something the UI thought was
 * fine — it keeps the dialog open rather than discarding the freeze.
 */
export async function confirmPublish(acknowledgeDrift = false): Promise<void> {
  const pending = pendingPublish();
  if (!pending) return;

  const terms = pending.summary.terms;
  const needsTerms = !!terms && !terms.accepted;
  if (needsTerms && !termsAgreed()) {
    setStatus('Accept the Publisher Terms to publish.');
    return;
  }

  setStatus(`Publishing ${pending.app.name}…`, false);
  await withLoading(
    setConfirmBusy,
    async () => {
      const outcome = await hostConfirmPublish(
        pending.app,
        pending.summary.publicationId,
        acknowledgeDrift,
        needsTerms ? terms.version : undefined,
      );
      if (outcome.published) {
        setPendingPublish(null);
        setTermsAgreed(false);
        setStatus(outcome.message || `Published ${pending.app.name} to the marketplace`);
        // Ownership may have just been claimed — refresh so the badge reflects it.
        // Not awaited: the publish is already done and reported, and this is two more
        // round trips (one of them to the marketplace) that would otherwise hold the
        // dialog's spinner up after the only answer the user was waiting for arrived.
        void refreshAccount();
      } else if (outcome.status === 'drift_detected') {
        setPendingPublish({
          ...pending,
          drift: { changedFiles: outcome.drift?.changedFiles ?? [] },
        });
        setStatus('Source changed since prepare — review the changes.');
      } else if (outcome.status === 'terms_required') {
        // The freeze survives an unaccepted-terms refusal, so the dialog stays open
        // and the user can tick the box and press Publish again.
        setTermsAgreed(false);
        setStatus(outcome.message || 'Accept the Publisher Terms to publish.');
      } else {
        // expired / not_found / error: the freeze is gone or unusable — close and report.
        setPendingPublish(null);
        setTermsAgreed(false);
        setStatus(outcome.message || 'Publish failed.');
      }
    },
    (msg) => setStatus(`Publish failed: ${msg}`),
  );
}

/**
 * The protocol publish slot, held for a whole `publish` call or a whole `publishAll`
 * run. A plain variable for the reason `runInFlight` in update-all.ts is one: the guard
 * must be up before the first await.
 */
let agentPublishInFlight = false;

/**
 * Why a protocol publish cannot start now, or null when it can. An open dialog holds
 * its own freeze; publishing underneath it would race the user.
 */
export function publishBusyReason(): string | null {
  const run = publishRun();
  if (run.active) {
    return `A publishAll run is in progress (${run.completed}/${run.total} done) — wait on waitPublish, then retry.`;
  }
  if (agentPublishInFlight) {
    return 'Another publish is in progress in Market Apps — retry once it finishes.';
  }
  if (pendingPublish()) {
    return 'The publish dialog is open in Market Apps — retry once the user closes it.';
  }
  return null;
}

/** Take the slot; false when it is already held. Pair every true with `releasePublishSlot`. */
export function claimPublishSlot(): boolean {
  if (agentPublishInFlight || pendingPublish()) return false;
  agentPublishInFlight = true;
  return true;
}

export function releasePublishSlot(): void {
  agentPublishInFlight = false;
}

export type PublishApp = { id: string; name: string };

/** The id as given, named after the installed app it matches when there is one. */
export function resolvePublishApp(appId: string): PublishApp {
  const id = appId.trim();
  const target = normalizeId(id);
  return { id, name: installedApps().find((a) => normalizeId(a.id) === target)?.name ?? id };
}

function settle(
  app: PublishApp,
  fields: Omit<PublishResult, 'appId' | 'finishedAt'>,
): PublishResult {
  return { appId: app.id, ...fields, finishedAt: new Date().toISOString() };
}

/**
 * One protocol publish with the slot already held: never throws, and records its
 * answer in `lastPublish`. A thrown prepare (not newer, not owner, signed out) becomes
 * status `error`, with a sign-in hint when no publisher is signed in.
 */
export async function attemptPublish(
  app: PublishApp,
  expectedVersion?: string,
): Promise<PublishResult> {
  let result: PublishResult;
  try {
    result = await publishOnce(app, expectedVersion?.trim() || undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = account().signedIn
      ? ''
      : ' No publisher is signed in — the user must sign in from the Market Apps account panel.';
    result = settle(app, { published: false, status: 'error', message: message + hint });
  }
  setLastPublish(result);
  setSharedLastPublish(result);
  return result;
}

/**
 * The protocol's one-shot publish: prepare, check, confirm — no dialog.
 *
 * Two things it never does on the caller's behalf. It never accepts the Publisher
 * Terms: the host holds that consent to be the user's, given in the dialog, so an
 * unaccepted agreement discards the freeze and answers `terms_required`. And it never
 * ships across drift: a `drift_detected` confirm discards the freeze, so a retry
 * re-packages the current files instead of uploading a stale snapshot.
 *
 * Every outcome is returned rather than thrown, and every one but `busy` is recorded
 * in `lastPublish` — a `busy` answer must not overwrite the result of the publish it
 * was refused for.
 */
export async function publishForAgent(params: {
  appId: string;
  expectedVersion?: string;
}): Promise<PublishResult> {
  const app = resolvePublishApp(params.appId);

  const busy = publishBusyReason();
  if (busy || !claimPublishSlot()) {
    return settle(app, {
      published: false,
      status: 'busy',
      message: busy ?? 'Another publish is in progress in Market Apps — retry once it finishes.',
    });
  }

  let result = settle(app, { published: false, status: 'error', message: 'Publish did not run.' });
  try {
    await runAction(
      `Publishing ${app.name}…`,
      async () => {
        result = await attemptPublish(app, params.expectedVersion);
      },
      'Publish failed',
    );
  } finally {
    releasePublishSlot();
  }

  setStatus(result.published ? result.message : `Publish failed: ${result.message}`);
  if (result.published) void refreshAccount();
  return result;
}

async function publishOnce(app: PublishApp, expectedVersion?: string): Promise<PublishResult> {
  // A not-newer version, a missing sign-in or a non-owner is refused here, as a throw.
  const summary = await hostPreparePublish(app);
  const frozen = {
    version: summary.version,
    artifactSha256: summary.artifactSha256,
    byteLength: summary.byteLength,
  };
  const discard = () => hostCancelPublish(app, summary.publicationId).catch(() => undefined);

  if (summary.terms && !summary.terms.accepted) {
    await discard();
    return settle(app, {
      ...frozen,
      published: false,
      status: 'terms_required',
      message: `The signed-in publisher has not accepted the Publisher Terms v${summary.terms.version}. The user must accept them by publishing once from the Market Apps dialog; an agent cannot.`,
    });
  }

  if (expectedVersion && summary.version !== expectedVersion) {
    await discard();
    return settle(app, {
      ...frozen,
      published: false,
      status: 'version_mismatch',
      message: `Installed ${app.name} is v${summary.version ?? '(none)'}, not v${expectedVersion}.`,
    });
  }

  const outcome = await hostConfirmPublish(app, summary.publicationId, false);
  if (outcome.published) {
    return settle(app, {
      ...frozen,
      published: true,
      status: 'published',
      message:
        outcome.message || `Published ${app.name} v${summary.version ?? '?'} to the marketplace`,
    });
  }

  // Drift and unaccepted terms leave the freeze alive; the rest have already lost it.
  await discard();
  return settle(app, {
    ...frozen,
    published: false,
    status: outcome.status && outcome.status !== 'published' ? outcome.status : 'error',
    message: outcome.message || 'Publish failed.',
    ...(outcome.status === 'drift_detected'
      ? { changedFiles: outcome.drift?.changedFiles ?? [] }
      : {}),
  });
}

/** Dismiss the dialog and discard the host-side freeze (best-effort — it also expires). */
export async function cancelPublish(): Promise<void> {
  const pending = pendingPublish();
  setPendingPublish(null);
  setTermsAgreed(false);
  if (!pending) return;
  try {
    await hostCancelPublish(pending.app, pending.summary.publicationId);
  } catch {
    /* best-effort: the frozen bytes are swept on TTL expiry regardless */
  }
  setStatus('Publish cancelled.');
}
