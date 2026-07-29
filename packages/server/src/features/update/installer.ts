/**
 * The filesystem half of a self-update: download, verify, swap.
 *
 * Two rules shape this file.
 *
 * **Nothing unverified is ever installed.** `SHA256SUMS` is fetched first and a
 * missing or incomplete manifest is a hard failure here, unlike install.sh, which
 * warns and continues. The installer soft-fails because it must still work against
 * releases cut before the manifest existed and against a `VERSION=` pin at one of
 * those tags; an in-app updater only ever targets *the latest* release, which always
 * publishes one. A user who clicks a button and walks away has no shell to read a
 * warning in, so the only safe reading of "no manifest" is "do not install".
 *
 * **Staging happens next to the binary, not in the system temp dir.** The swap is
 * `rename(2)`, which fails across filesystems — and `/tmp` very often is one. Staging
 * in a sibling directory of `process.execPath` keeps every rename on the same device,
 * so the moment of replacement stays atomic instead of becoming a copy that can be
 * interrupted halfway.
 */

import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { APPS_ASSET, SUMS_ASSET, assetUrl, parseSums } from './release.js';

/** Reports progress of the current step as a 0..1 fraction, or undefined if unknown. */
export type ProgressFn = (fraction: number | undefined) => void;

type FetchLike = typeof fetch;

export interface InstallPaths {
  /** The running executable, replaced by the update. */
  exePath: string;
  /** Directory holding the exe — also where `apps/` and the staging dir live. */
  installDir: string;
  /** Scratch directory for this run, on the same filesystem as `exePath`. */
  stagingDir: string;
}

export function resolveInstallPaths(exePath: string): InstallPaths {
  const installDir = dirname(exePath);
  return { exePath, installDir, stagingDir: join(installDir, '.yaar-update') };
}

/**
 * Download `url` to `dest`, returning its SHA-256 as lowercase hex.
 *
 * Hashes the same chunks it writes, so the digest describes the bytes that landed on
 * disk rather than a second read of a file that could have changed in between.
 */
async function downloadToFile(
  url: string,
  dest: string,
  fetchImpl: FetchLike,
  onProgress?: ProgressFn,
): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'yaar-updater' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  if (!res.body) throw new Error(`Download returned no body: ${url}`);

  const declared = Number(res.headers.get('content-length') ?? '');
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;

  const hasher = new Bun.CryptoHasher('sha256');
  const sink = Bun.file(dest).writer();
  let received = 0;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hasher.update(chunk);
      sink.write(chunk);
      received += chunk.byteLength;
      onProgress?.(total ? Math.min(received / total, 1) : undefined);
    }
    await sink.end();
  } catch (err) {
    // Leave no half-written artifact behind for a retry to mistake for a good one.
    try {
      await sink.end();
    } catch {
      /* the sink is already broken; the unlink below is what matters */
    }
    await rm(dest, { force: true });
    throw err;
  }

  return hasher.digest('hex');
}

/** Fetch and parse the release's checksum manifest. Throws if it is absent or empty. */
export async function fetchSums(tag: string, fetchImpl: FetchLike): Promise<Map<string, string>> {
  const res = await fetchImpl(assetUrl(tag, SUMS_ASSET), {
    headers: { 'User-Agent': 'yaar-updater' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(
      `Release ${tag} publishes no ${SUMS_ASSET} (${res.status}). Refusing to install unverified files — download it from the releases page instead.`,
    );
  }
  const sums = parseSums(await res.text());
  if (sums.size === 0) {
    throw new Error(`${SUMS_ASSET} for ${tag} could not be parsed. Refusing to install.`);
  }
  return sums;
}

/** Download one asset and check it against the manifest. Mismatch throws. */
async function fetchVerifiedAsset(
  tag: string,
  name: string,
  dest: string,
  sums: Map<string, string>,
  fetchImpl: FetchLike,
  onProgress?: ProgressFn,
): Promise<void> {
  const want = sums.get(name);
  if (!want) {
    throw new Error(`${SUMS_ASSET} for ${tag} lists no checksum for ${name}. Refusing to install.`);
  }

  const got = await downloadToFile(assetUrl(tag, name), dest, fetchImpl, onProgress);
  if (got !== want) {
    await rm(dest, { force: true });
    throw new Error(
      `Checksum mismatch for ${name} — refusing to install.\n  expected: ${want}\n  actual:   ${got}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the apps archive with the system `tar`.
 *
 * The same tool both installers use, and present by default on macOS, Linux, and
 * Windows 10+. Bun ships no tar reader, and vendoring one to save a spawn would be
 * a larger surface than the spawn is.
 */
async function extractApps(archive: string, into: string): Promise<void> {
  const proc = Bun.spawn(['tar', '-xzf', archive, '-C', into], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`Could not unpack ${APPS_ASSET} (tar exited ${code}): ${stderr.trim()}`);
  }
  if (!(await exists(join(into, 'apps')))) {
    throw new Error(`${APPS_ASSET} did not contain an apps/ directory.`);
  }
}

export interface InstallOptions {
  tag: string;
  /** Binary asset name for this platform, from `assetNameFor`. */
  binaryAsset: string;
  paths: InstallPaths;
  fetchImpl?: FetchLike;
  /** Called as each phase begins, so the UI can name what is happening. */
  onPhase?: (phase: 'downloading' | 'verifying' | 'installing', detail: string) => void;
  onProgress?: ProgressFn;
}

/**
 * Download, verify, and swap in a release. Returns when the new files are in place;
 * the running process still holds the old code, so the caller must tell the user to
 * restart.
 *
 * Order is deliberate: `apps/` is swapped before the binary. Both halves are
 * individually survivable (apps are plain HTML and the previous binary reads new
 * apps fine), but the binary swap is the one that cannot be undone from inside this
 * process — it goes last, and if it fails the original is renamed back.
 */
export async function installRelease(opts: InstallOptions): Promise<void> {
  const { tag, binaryAsset, paths } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { exePath, installDir, stagingDir } = paths;

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    opts.onPhase?.('verifying', `Reading ${SUMS_ASSET}`);
    const sums = await fetchSums(tag, fetchImpl);

    const stagedBinary = join(stagingDir, binaryAsset);
    opts.onPhase?.('downloading', binaryAsset);
    await fetchVerifiedAsset(tag, binaryAsset, stagedBinary, sums, fetchImpl, opts.onProgress);

    const stagedApps = join(stagingDir, APPS_ASSET);
    opts.onPhase?.('downloading', APPS_ASSET);
    await fetchVerifiedAsset(tag, APPS_ASSET, stagedApps, sums, fetchImpl, opts.onProgress);

    opts.onPhase?.('installing', 'Unpacking apps');
    opts.onProgress?.(undefined);
    await extractApps(stagedApps, stagingDir);

    // ── Swap apps/ ──
    const appsDir = join(installDir, 'apps');
    const appsBackup = join(installDir, 'apps.previous');
    await rm(appsBackup, { recursive: true, force: true });
    if (await exists(appsDir)) await rename(appsDir, appsBackup);
    try {
      await rename(join(stagingDir, 'apps'), appsDir);
    } catch (err) {
      if (await exists(appsBackup)) await rename(appsBackup, appsDir);
      throw err;
    }
    await rm(appsBackup, { recursive: true, force: true });

    // ── Swap the binary ──
    //
    // Renaming a running executable is permitted on every platform we ship to
    // (POSIX keeps the inode alive; Windows allows the rename but not a delete).
    // The backup is therefore left in place rather than unlinked — this process
    // is still executing it — and the *previous* run's backup is cleared first.
    opts.onPhase?.('installing', 'Replacing the binary');
    const exeBackup = `${exePath}.previous`;
    await rm(exeBackup, { force: true }).catch(() => {});
    await rename(exePath, exeBackup);
    try {
      await rename(stagedBinary, exePath);
      if (process.platform !== 'win32') await chmod(exePath, 0o755);
    } catch (err) {
      await rename(exeBackup, exePath).catch(() => {});
      throw err;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
