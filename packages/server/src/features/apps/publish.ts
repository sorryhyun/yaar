/**
 * Publish an app to the marketplace.
 *
 * The app directory goes up as a tar.gz, authenticated by the **Google ID token**
 * from `features/market/google-auth.ts` — a JWT signed by Google asserting the
 * publisher's email, which the marketplace verifies against Google's public keys.
 * No shared secret crosses the wire, and the refresh token never leaves this
 * machine.
 *
 * The marketplace commits the app into its own repo, so publishing is queued, not
 * instant: the response says "live in ~1 minute", once the redeploy lands.
 */

import { dirname, basename } from 'path';
import { spawn } from 'bun';
import { MARKET_URL } from '../../config.js';
import { getAuthStatus, getIdToken } from '../market/google-auth.js';
import { termsGateError } from './publisher-terms.js';
import { appIdRefusal, resolveAppDir } from './roots.js';
import { notePublishedVersion, readAppVersion, versionPublishError } from './version.js';
import { errMessage } from '../../lib/errors.js';

/** Upstream hiccups, not a rejection of this publish — worth another shot. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const PUBLISH_ATTEMPTS = 3;
/** One delay per retry, so `PUBLISH_ATTEMPTS - 1` entries. */
const PUBLISH_RETRY_DELAYS_MS = [1000, 4000];

export interface PublishResult {
  success: boolean;
  error?: string;
  /**
   * Why the publish was refused, when the reason is one a caller can act on rather
   * than merely report. `terms_required` is the publisher agreement gate.
   */
  code?: 'terms_required';
  /** The marketplace's human-facing note, e.g. "live in ~1 minute". */
  message?: string;
  commit?: string;
  files?: number;
}

/**
 * tar.gz of the app directory, entries prefixed `{appId}/` — the same shape
 * `GET /api/apps/{id}/download` produces, so the round trip is symmetric.
 *
 * `dist/` is excluded: the marketplace ships source and YAAR compiles on install,
 * so uploading build output would only bloat the archive and stale the repo.
 *
 * Note the gzip stream is **not** byte-deterministic — `tar czf` stamps an mtime
 * into the gzip header — so two archives of identical source hash differently.
 * That is fine for the freeze-and-ship model (`publish-staging.ts`): the artifact
 * digest attests *these exact frozen bytes*, and source-drift detection uses
 * `computeSourceHash` over `src/` content, never a re-tar comparison.
 *
 * **Why this is still a spawn when the two extract paths are not.** `Bun.Archive`
 * replaced the `tar` spawns in `apps/archive.ts` and `update/installer.ts`; this one
 * stayed, deliberately. Measured on 1.4.0: `Bun.Archive` emits `ustar\0`00 with
 * *regular-file entries only* — no directory members — mode 0644, and an mtime from
 * the current clock (so no determinism is gained either, which was the gate for
 * touching creation at all). Every entry here crosses the wire to the marketplace's
 * own server-side extractor, which this repo cannot test; swapping a reader is
 * reversible in one process, swapping what a *published* artifact looks like is not.
 * Revisit when there is a way to verify the far end.
 */
export async function packageAppTarball(appId: string, appDir: string): Promise<Buffer> {
  const proc = spawn(
    [
      'tar',
      'czf',
      '-',
      '--exclude',
      `${basename(appDir)}/dist`,
      // Unanchored so they catch macOS cruft at any depth: `.DS_Store` (Finder drops
      // these into every browsed directory) and `._*` AppleDouble sidecars (macOS
      // writes `._app.json` next to a file when it crosses a filesystem that can't
      // hold xattrs — a zip extract, USB/network share). Neither belongs on the marketplace.
      '--exclude',
      '.DS_Store',
      '--exclude',
      '._*',
      '-C',
      dirname(appDir),
      basename(appDir),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      // Belt-and-suspenders: on tar builds that *do* emit AppleDouble metadata for
      // xattr-bearing files (older/Apple bsdtar), this suppresses the synthesized
      // `._{name}` members. GNU tar and libarchive 3.5+ ignore it, so it's a no-op there.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );

  const [tarball, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `tar exited with code ${exitCode}`);
  }
  return Buffer.from(tarball);
}

/** Said in one voice by every path that needs a publisher and hasn't got one. */
const SIGNED_OUT_ERROR =
  'Not signed in to Google. Open the Market Apps window and sign in to publish.';

/**
 * Upload an already-built tarball to the marketplace, authenticated by the Google
 * ID token. Split out from `publishApp` so the two-phase publish flow
 * (`publish-staging.ts`) can ship its *frozen* bytes through the identical path —
 * same auth, same retry policy, same response parsing.
 *
 * This is also **the** publisher-terms chokepoint: every route to the marketplace —
 * the one-shot `publishApp`, the two-phase `finalizePublication`, an agent invoking
 * `yaar://apps/{id}` directly — passes through here, so the agreement is checked
 * once, in front of the network call, rather than once per caller.
 */
export async function uploadTarball(appId: string, tarball: Buffer): Promise<PublishResult> {
  // Local read, no network: it answers both "is there a publisher" and "who", which
  // is what the terms are keyed on. Asking before minting an ID token also keeps a
  // refused publish from spending a token refresh on the way to being refused.
  const auth = await getAuthStatus();
  if (!auth.signedIn || !auth.email) return { success: false, error: SIGNED_OUT_ERROR };

  const termsError = await termsGateError(auth.email);
  if (termsError) return { success: false, error: termsError, code: 'terms_required' };

  const idToken = await getIdToken().catch((err) => {
    // An expired refresh grant surfaces here as "sign in again" — pass it through
    // rather than flattening it into a generic publish failure.
    throw new Error(errMessage(err));
  });
  if (!idToken) return { success: false, error: SIGNED_OUT_ERROR };

  const form = new FormData();
  form.append('tarball', new Blob([tarball], { type: 'application/gzip' }), `${appId}.tar.gz`);

  let res: Response | null = null;
  let lastError: string | null = null;

  // The marketplace commits through the GitHub Git Data API, which sheds load with a
  // 503 ("No server is currently available") often enough that a one-shot publish is
  // a coin flip. Retrying is safe: nothing is committed until the whole upload lands.
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(PUBLISH_RETRY_DELAYS_MS[attempt - 1]);

    try {
      res = await fetch(`${MARKET_URL}/api/apps/${appId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: form,
      });
    } catch (err) {
      // A dropped connection is as transient as a 503 — retry it the same way.
      res = null;
      lastError = `Could not reach the marketplace: ${errMessage(err)}`;
      continue;
    }

    if (!TRANSIENT_STATUS.has(res.status)) break;
    lastError = `Publish failed (${res.status}).`;
  }

  if (!res) return { success: false, error: lastError ?? 'Publish failed.' };

  const body = (await res.json().catch(() => null)) as {
    detail?: string;
    message?: string;
    commit?: string;
    files?: number;
  } | null;

  if (!res.ok) {
    // FastAPI puts the reason in `detail`; it is the only useful part of a 4xx.
    const detail = body?.detail ?? `Publish failed (${res.status}).`;
    return {
      success: false,
      error: TRANSIENT_STATUS.has(res.status)
        ? `${detail} (retried ${PUBLISH_ATTEMPTS} times — the marketplace or GitHub is having trouble; try again shortly.)`
        : detail,
    };
  }

  return {
    success: true,
    message: body?.message ?? `Published "${appId}".`,
    commit: body?.commit,
    files: body?.files,
  };
}

/**
 * Single-phase publish: package the app's *current* on-disk state and upload it in
 * one shot. There is no window between packaging and upload, so no source-drift
 * detection is needed here. The two-phase flow in `publish-staging.ts` opens that
 * window (freeze at prepare, upload at confirm) and adds the detection for it.
 */
export async function publishApp(appId: string): Promise<PublishResult> {
  const refusal = appIdRefusal(appId);
  if (refusal) return { success: false, error: refusal };

  const appDir = resolveAppDir(appId);
  if (!appDir) return { success: false, error: `App "${appId}" is not installed.` };

  const version = await readAppVersion(appDir);
  const versionError = await versionPublishError(appId, version);
  if (versionError) return { success: false, error: versionError };

  let tarball: Buffer;
  try {
    tarball = await packageAppTarball(appId, appDir);
  } catch (err) {
    return { success: false, error: `Failed to package "${appId}": ${errMessage(err)}` };
  }

  const result = await uploadTarball(appId, tarball);
  // The catalog will not show this for about a minute; tell the guard directly.
  if (result.success) notePublishedVersion(appId, version);
  return result;
}
