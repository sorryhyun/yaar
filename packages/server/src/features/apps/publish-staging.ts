/**
 * Two-phase publishing with source-drift detection.
 *
 * The single-phase `publishApp` tars the live directory and uploads it in one
 * call, so there is no window in which the source can change under the user. This
 * flow deliberately opens that window — `prepare` freezes the exact bytes the user
 * will approve, `confirm` uploads *those frozen bytes* — and adds the detection the
 * window then requires:
 *
 *   prepare  → package + hash + FREEZE bytes to disk, record a source baseline
 *   confirm  → re-hash the live source; if it drifted, refuse unless acknowledged;
 *              then upload the frozen bytes (never a fresh re-tar)
 *
 * Two independent guarantees, per the session-bound-publishing proposal:
 *
 *  - **Integrity** — the frozen tarball + its `artifactSha256` are the bytes that
 *    ship. Whatever happens to the working tree after `prepare` cannot change what
 *    is uploaded.
 *  - **Drift detection** — `computeSourceHash`/`computeAppJsonHash` over the live
 *    `src/` + `app.json` are the authoritative "did the source move" gate (content
 *    hashes, deterministic). `appDiff` supplies the *which files* detail for a
 *    human confirmation, best-effort, only once drift is already known.
 *
 * We hash source rather than re-tarring because the gzip stream is not
 * byte-deterministic (`tar czf` stamps an mtime), so a re-tar would always differ
 * even when nothing changed. Source content hashing is the correct drift signal.
 */

import { join } from 'path';
import { mkdir, rm, readFile } from 'fs/promises';
import { computeSourceHash, computeAppJsonHash } from '@yaar/compiler';
import { getStorageDir } from '../../config.js';
import { errMessage } from '../../lib/errors.js';
import { resolveAppDir } from './roots.js';
import { readAppVersion, versionPublishError } from './version.js';
import { isValidAppId, packageAppTarball, uploadTarball, type PublishResult } from './publish.js';

/** How long a frozen publication stays valid before its bytes are swept. */
const PENDING_TTL_MS = 15 * 60 * 1000;

/** The content baseline captured at prepare — the authoritative drift anchor. */
export interface SourceBaseline {
  /** SHA-256 over `src/**` (path + content, sorted). */
  sourceHash: string;
  /** SHA-256 over `app.json`. This is the proposal's `manifestSha256`. */
  appJsonHash: string;
}

/** A frozen, awaiting-confirmation publication. */
export interface PendingPublication {
  publicationId: string;
  appId: string;
  /** From `app.json` at prepare time, for the confirmation summary. May be null. */
  version: string | null;
  baseline: SourceBaseline;
  /** SHA-256 of the frozen tarball bytes — the integrity anchor. */
  artifactSha256: string;
  byteLength: number;
  /** Where the frozen tar.gz lives on disk until confirm/cancel/expiry. */
  stagingPath: string;
  preparedAt: number;
  expiresAt: number;
}

/**
 * Public, JSON-safe view of a pending publication — no absolute staging path.
 */
export interface PreparedSummary {
  publicationId: string;
  appId: string;
  version: string | null;
  artifactSha256: string;
  manifestSha256: string;
  byteLength: number;
  expiresAt: string;
}

export interface DriftResult {
  drifted: boolean;
  /**
   * Files changed since prepare, relative to the app dir. Best-effort: comes from
   * the per-app shadow git repo and is empty when that repo has no matching base.
   * The boolean above — not this list — is authoritative.
   */
  changedFiles: string[];
}

/** Metadata lives in-process; the frozen *bytes* live on disk (survive a GC, not a restart). */
const pending = new Map<string, PendingPublication>();

function stagingDir(): string {
  return join(getStorageDir(), 'publish-staging');
}

function summarize(p: PendingPublication): PreparedSummary {
  return {
    publicationId: p.publicationId,
    appId: p.appId,
    version: p.version,
    artifactSha256: p.artifactSha256,
    manifestSha256: p.baseline.appJsonHash,
    byteLength: p.byteLength,
    expiresAt: new Date(p.expiresAt).toISOString(),
  };
}

/**
 * Capture the source baseline for an app directory. Path-based and pure so the
 * drift core is testable without an appId or a shadow repo.
 */
export async function captureBaseline(appDir: string): Promise<SourceBaseline> {
  const [sourceHash, appJsonHash] = await Promise.all([
    computeSourceHash(appDir),
    computeAppJsonHash(appDir),
  ]);
  return { sourceHash, appJsonHash };
}

/**
 * Authoritative drift check: does the live source still match the baseline?
 * Content hashes only — no file list. Pure and path-based.
 */
export async function baselineDrifted(appDir: string, base: SourceBaseline): Promise<boolean> {
  const now = await captureBaseline(appDir);
  return now.sourceHash !== base.sourceHash || now.appJsonHash !== base.appJsonHash;
}

/** Drop a pending record and its frozen bytes. Safe to call for an unknown id. */
export async function cancelPublication(publicationId: string): Promise<boolean> {
  const p = pending.get(publicationId);
  if (!p) return false;
  pending.delete(publicationId);
  await rm(p.stagingPath, { force: true }).catch(() => {});
  return true;
}

/** Sweep and discard anything past its TTL. Runs opportunistically on prepare. */
async function sweepExpired(): Promise<void> {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.expiresAt <= now) await cancelPublication(id);
  }
}

/**
 * Phase 1 — freeze. Package the app's current state, hash it, write the tarball to
 * staging, and record the baseline. Any prior pending publication for the same app
 * is cancelled first (one live freeze per app, per the proposal's state machine).
 */
export async function preparePublication(
  appId: string,
  opts: { publishedVersionOf?: (id: string) => Promise<string | null> } = {},
): Promise<{ success: true; summary: PreparedSummary } | { success: false; error: string }> {
  if (!isValidAppId(appId)) return { success: false, error: `Invalid app id "${appId}".` };

  const appDir = resolveAppDir(appId);
  if (!appDir) return { success: false, error: `App "${appId}" is not installed.` };

  // Refuse a not-newer version before we bother packaging or freezing anything.
  const version = await readAppVersion(appDir);
  const versionError = await versionPublishError(appId, version, opts.publishedVersionOf);
  if (versionError) return { success: false, error: versionError };

  await sweepExpired();
  // One live freeze per app: supersede an earlier, un-confirmed prepare.
  for (const [id, p] of pending) {
    if (p.appId === appId) await cancelPublication(id);
  }

  let tarball: Buffer;
  let baseline: SourceBaseline;
  try {
    [tarball, baseline] = await Promise.all([
      packageAppTarball(appId, appDir),
      captureBaseline(appDir),
    ]);
  } catch (err) {
    return { success: false, error: `Failed to package "${appId}": ${errMessage(err)}` };
  }

  const artifactSha256 = new Bun.CryptoHasher('sha256').update(tarball).digest('hex');
  const publicationId = `pubver_${crypto.randomUUID()}`;
  const stagingPath = join(stagingDir(), `${publicationId}.tar.gz`);

  try {
    await mkdir(stagingDir(), { recursive: true });
    await Bun.write(stagingPath, tarball);
  } catch (err) {
    return { success: false, error: `Failed to stage "${appId}": ${errMessage(err)}` };
  }

  const now = Date.now();
  const record: PendingPublication = {
    publicationId,
    appId,
    version,
    baseline,
    artifactSha256,
    byteLength: tarball.byteLength,
    stagingPath,
    preparedAt: now,
    expiresAt: now + PENDING_TTL_MS,
  };
  pending.set(publicationId, record);
  return { success: true, summary: summarize(record) };
}

/** Read-only status of a pending publication. */
export function getPendingPublication(publicationId: string): PreparedSummary | null {
  const p = pending.get(publicationId);
  return p ? summarize(p) : null;
}

/**
 * Has the source drifted from the frozen baseline? Authoritative boolean plus a
 * best-effort changed-file list (from the shadow git repo) for the confirmation UI.
 */
export async function detectDrift(publicationId: string): Promise<DriftResult | null> {
  const p = pending.get(publicationId);
  if (!p) return null;

  const appDir = resolveAppDir(p.appId);
  // The app vanished (uninstalled) after prepare — treat as drift; the frozen bytes
  // may still ship, but the caller must acknowledge it explicitly.
  if (!appDir) return { drifted: true, changedFiles: [] };

  const drifted = await baselineDrifted(appDir, p.baseline);
  if (!drifted) return { drifted: false, changedFiles: [] };

  let changedFiles: string[] = [];
  try {
    const { appDiff } = await import('../dev/git.js');
    const diff = await appDiff(p.appId);
    if ('files' in diff) changedFiles = diff.files;
  } catch {
    /* shadow repo unavailable — boolean drift already answered the question */
  }
  return { drifted: true, changedFiles };
}

export interface ConfirmResult {
  status: 'published' | 'drift_detected' | 'expired' | 'not_found' | 'error';
  /** Present on `published`. */
  result?: PublishResult;
  /** Present on `drift_detected`. */
  drift?: DriftResult;
  message?: string;
}

/**
 * Phase 2 — confirm. Refuse the upload if the source drifted since prepare, unless
 * the caller explicitly acknowledges shipping the frozen snapshot. On success, the
 * *frozen* bytes go up (never a re-tar) and the pending record is cleared.
 *
 * `upload` is injectable purely so tests can exercise the drift gate without a
 * network round-trip; production always uses `uploadTarball`.
 */
export async function finalizePublication(
  publicationId: string,
  opts: {
    /** Ship the frozen snapshot even though the source changed since prepare. */
    acknowledgeDrift?: boolean;
    /** The app the caller believes it is confirming, cross-checked against the freeze. */
    expectedAppId?: string;
    upload?: (appId: string, tarball: Buffer) => Promise<PublishResult>;
  } = {},
): Promise<ConfirmResult> {
  const p = pending.get(publicationId);
  if (!p) return { status: 'not_found', message: `No pending publication "${publicationId}".` };

  if (opts.expectedAppId && opts.expectedAppId !== p.appId) {
    return {
      status: 'error',
      message: `Publication "${publicationId}" belongs to "${p.appId}", not "${opts.expectedAppId}".`,
    };
  }

  if (p.expiresAt <= Date.now()) {
    await cancelPublication(publicationId);
    return { status: 'expired', message: 'This publication expired. Prepare it again.' };
  }

  const drift = await detectDrift(publicationId);
  if (drift?.drifted && !opts.acknowledgeDrift) {
    return {
      status: 'drift_detected',
      drift,
      message:
        'Source changed since prepare. Re-prepare to publish the new source, or confirm ' +
        'again with acknowledgeDrift: true to publish the frozen snapshot as-is.',
    };
  }

  let tarball: Buffer;
  try {
    tarball = await readFile(p.stagingPath);
  } catch (err) {
    await cancelPublication(publicationId);
    return { status: 'error', message: `Frozen artifact is gone: ${errMessage(err)}` };
  }

  const upload = opts.upload ?? uploadTarball;
  const result = await upload(p.appId, tarball);
  // Only a successful upload consumes the freeze; a transient failure leaves it so
  // the caller can retry the same bytes while the nonce/TTL is still valid.
  if (result.success) await cancelPublication(publicationId);
  return { status: result.success ? 'published' : 'error', result, message: result.error };
}

/** Test-only: overwrite a pending baseline to simulate source drift. */
export function __setBaselineForTest(publicationId: string, baseline: SourceBaseline): void {
  const p = pending.get(publicationId);
  if (p) p.baseline = baseline;
}
