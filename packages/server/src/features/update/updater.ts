/**
 * Update orchestration: what version is running, what version is published, and
 * the state of an install in flight.
 *
 * The split between the two verbs on `yaar://system/update` is deliberate and the
 * whole reason this holds state at all:
 *
 * - `read` never touches the network. It answers from the last check plus live
 *   install progress, so the configurations app can poll it once a second while an
 *   install runs without spending GitHub's 60-requests-per-hour anonymous budget.
 * - `invoke {action:'check'}` is the one that goes out, behind a short cache so a
 *   user leaning on the button does not burn that budget either.
 *
 * `invoke {action:'install'}` returns as soon as the work is queued rather than
 * awaiting it. A verified download of a ~100 MB binary plus the apps archive is a
 * minutes-long operation on a slow link; holding an HTTP request open for it would
 * make an ordinary slow network indistinguishable from a hang, and would give the
 * UI nothing to render in the meantime.
 */

import { IS_BUNDLED_EXE, YAAR_VERSION } from '../../config.js';
import { assetNameFor, fetchLatestRelease, type ReleaseInfo } from './release.js';
import { installRelease, resolveInstallPaths } from './installer.js';
import { isNewer } from './semver.js';

export type UpdateStage = 'idle' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error';

export interface UpdateProgress {
  stage: UpdateStage;
  /** Human-readable description of the current step, e.g. "yaar-macos-arm64". */
  detail?: string;
  /** 0..1 for the current download, absent when the step has no measurable size. */
  fraction?: number;
  /** Version being installed. */
  targetVersion?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** Why this build cannot install an update itself, when it cannot. */
export type BlockedReason = 'source-checkout' | 'unsupported-platform' | 'no-asset';

export interface UpdateStatus {
  current: string;
  /** True for the standalone executable — the only shape that can replace itself. */
  bundled: boolean;
  platform: string;
  arch: string;
  /** Release asset this machine needs, or null when none is published for it. */
  asset: string | null;
  /** False when a newer release exists but this build cannot apply it. */
  canInstall: boolean;
  blockedReason?: BlockedReason;
  /** Result of the last successful check, absent until one has run. */
  latest?: {
    version: string;
    tag: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string | null;
    updateAvailable: boolean;
    /** True when the release is missing the asset this machine needs. */
    assetMissing: boolean;
  };
  checkedAt?: number;
  checkError?: string;
  progress: UpdateProgress;
}

const CHECK_CACHE_MS = 5 * 60_000;

let progress: UpdateProgress = { stage: 'idle' };
let lastRelease: ReleaseInfo | null = null;
let lastCheckedAt = 0;
let lastCheckError: string | undefined;
let installInFlight: Promise<void> | null = null;

/** Test seam: the `fetch` the checker and installer use. */
let fetchImpl: typeof fetch = fetch;

/** Replace the fetch used for release checks and downloads. Test-only. */
export function setUpdateFetchForTest(impl: typeof fetch): void {
  fetchImpl = impl;
}

/** Clear cached check results and install state. Test-only. */
export function resetUpdateStateForTest(): void {
  progress = { stage: 'idle' };
  lastRelease = null;
  lastCheckedAt = 0;
  lastCheckError = undefined;
  installInFlight = null;
  fetchImpl = fetch;
}

function currentAsset(): string | null {
  return assetNameFor(process.platform, process.arch);
}

function blockedReason(asset: string | null): BlockedReason | undefined {
  if (!IS_BUNDLED_EXE) return 'source-checkout';
  if (!asset) return 'unsupported-platform';
  return undefined;
}

/** Current status, from cache only — never hits the network. */
export function getUpdateStatus(): UpdateStatus {
  const asset = currentAsset();
  const reason = blockedReason(asset);

  const status: UpdateStatus = {
    current: YAAR_VERSION,
    bundled: IS_BUNDLED_EXE,
    platform: process.platform,
    arch: process.arch,
    asset,
    canInstall: reason === undefined,
    ...(reason ? { blockedReason: reason } : {}),
    ...(lastCheckedAt ? { checkedAt: lastCheckedAt } : {}),
    ...(lastCheckError ? { checkError: lastCheckError } : {}),
    progress,
  };

  if (lastRelease) {
    const assetMissing = asset !== null && !lastRelease.assets.some((a) => a.name === asset);
    status.latest = {
      version: lastRelease.version,
      tag: lastRelease.tag,
      name: lastRelease.name,
      notes: lastRelease.notes,
      url: lastRelease.htmlUrl,
      publishedAt: lastRelease.publishedAt,
      updateAvailable: isNewer(lastRelease.version, YAAR_VERSION),
      assetMissing,
    };
    // Only the reason that is actually first in the way. A source checkout is
    // blocked whether or not the release happens to ship this platform's binary,
    // and "download it from the releases page" is the wrong advice for one.
    if (assetMissing) {
      status.canInstall = false;
      status.blockedReason ??= 'no-asset';
    }
  }

  return status;
}

/**
 * Ask GitHub for the latest release and return the resulting status.
 *
 * A failed check is recorded on the status rather than thrown: the app still has a
 * version to display and a button to retry, and the caller of a *check* has learnt
 * everything it can. `force` bypasses the cache.
 */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const fresh = Date.now() - lastCheckedAt < CHECK_CACHE_MS;
  if (!force && lastRelease && fresh) return getUpdateStatus();

  try {
    lastRelease = await fetchLatestRelease(fetchImpl);
    lastCheckedAt = Date.now();
    lastCheckError = undefined;
  } catch (err) {
    lastCheckError = err instanceof Error ? err.message : String(err);
    lastCheckedAt = Date.now();
  }
  return getUpdateStatus();
}

export class UpdateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateRefused';
  }
}

/**
 * Begin installing the latest release. Returns once the work has *started*; poll
 * `getUpdateStatus().progress` for the outcome.
 *
 * Refuses (rather than queues) when there is nothing to install or this build cannot
 * install it, so the caller learns why synchronously instead of having to read a
 * failure back out of the progress state.
 */
export async function startInstall(): Promise<UpdateStatus> {
  if (installInFlight) throw new UpdateRefused('An update is already installing.');
  if (progress.stage === 'ready') {
    throw new UpdateRefused(
      `Version ${progress.targetVersion} is already installed — restart YAAR to run it.`,
    );
  }

  const status = await checkForUpdate();
  if (status.checkError) {
    throw new UpdateRefused(`Could not reach GitHub to check for updates: ${status.checkError}`);
  }
  if (!status.latest) throw new UpdateRefused('No release information available.');
  if (!status.latest.updateAvailable) {
    throw new UpdateRefused(`Already running the latest version (${status.current}).`);
  }
  if (!status.canInstall) {
    throw new UpdateRefused(refusalText(status));
  }

  const tag = status.latest.tag;
  const targetVersion = status.latest.version;
  const asset = status.asset as string;
  const paths = resolveInstallPaths(process.execPath);

  progress = { stage: 'verifying', targetVersion, startedAt: Date.now() };

  installInFlight = installRelease({
    tag,
    binaryAsset: asset,
    paths,
    fetchImpl,
    onPhase: (stage, detail) => {
      progress = { ...progress, stage, detail, fraction: undefined };
    },
    onProgress: (fraction) => {
      progress = { ...progress, fraction };
    },
  })
    .then(() => {
      progress = {
        stage: 'ready',
        targetVersion,
        detail: `Version ${targetVersion} installed. Restart YAAR to run it.`,
        startedAt: progress.startedAt,
        finishedAt: Date.now(),
      };
    })
    .catch((err: unknown) => {
      progress = {
        stage: 'error',
        targetVersion,
        error: err instanceof Error ? err.message : String(err),
        startedAt: progress.startedAt,
        finishedAt: Date.now(),
      };
    })
    .finally(() => {
      installInFlight = null;
    });

  return getUpdateStatus();
}

/** Explain a `canInstall: false` in a sentence a user can act on. */
export function refusalText(status: UpdateStatus): string {
  switch (status.blockedReason) {
    case 'source-checkout':
      return 'This YAAR runs from a source checkout, so it updates with `git pull && bun install`, not by replacing a binary.';
    case 'unsupported-platform':
      return `No release binary is published for ${status.platform}/${status.arch}. Build from source instead.`;
    case 'no-asset':
      return `Release ${status.latest?.tag} publishes no ${status.asset} asset. Download it from the releases page instead.`;
    default:
      return 'This build cannot install updates.';
  }
}
