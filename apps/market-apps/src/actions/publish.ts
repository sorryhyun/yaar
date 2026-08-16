// The two-phase publish flow: prepare + freeze, then confirm or cancel.

import { withLoading } from '@bundled/yaar';
import { hostCancelPublish, hostConfirmPublish, hostPreparePublish } from '../api/index.js';
import {
  pendingPublish,
  setConfirmBusy,
  setPendingPublish,
  setStatus,
  setTermsAgreed,
  termsAgreed,
} from '../store/index.js';
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