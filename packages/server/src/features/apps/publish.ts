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

import { basename, join } from 'path';
import { readdir } from 'fs/promises';
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
 * Every entry name in the tarball is `{appId}/...`, so a directory named after the
 * app is what the archive unpacks to — the shape `GET /api/apps/{id}/download`
 * produces and `extractAppArchive` strips one component from, so the round trip is
 * symmetric.
 */
const SKIPPED_DIRS = new Set(['dist']);

/** macOS cruft that has no business on the marketplace, at any depth. */
function isMacCruft(name: string): boolean {
  // Finder drops `.DS_Store` into every directory it browses; macOS writes a `._{name}`
  // AppleDouble sidecar next to a file when it crosses a filesystem that cannot hold
  // xattrs (a zip extract, a USB/network share).
  return name === '.DS_Store' || name.startsWith('._');
}

/**
 * Collect the app's publishable files as `{ 'appId/rel/path': bytes }`.
 *
 * `dist/` is excluded: the marketplace ships source and YAAR compiles on install,
 * so uploading build output would only bloat the archive and stale the repo.
 *
 * Regular files only. `readdir` with `withFileTypes` tells us what each entry is, and
 * anything that is neither a file nor a directory — a symlink, a socket, a device node —
 * is skipped rather than followed. An app is source text and has never needed one, and
 * this is the same posture `extractAppArchive` takes on the way back in.
 */
async function collectAppFiles(appDir: string): Promise<Record<string, Uint8Array>> {
  const prefix = basename(appDir);
  const entries: Record<string, Uint8Array> = {};

  async function walk(dir: string, rel: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      dirents.map(async (dirent) => {
        if (isMacCruft(dirent.name)) return;
        // Archive entry names are always `/`-separated, whatever the host uses.
        const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
        const abs = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (rel === '' && SKIPPED_DIRS.has(dirent.name)) return;
          await walk(abs, relPath);
        } else if (dirent.isFile()) {
          entries[`${prefix}/${relPath}`] = await Bun.file(abs).bytes();
        }
      }),
    );
  }

  await walk(appDir, '');
  if (Object.keys(entries).length === 0) {
    throw new Error(`"${prefix}" contains no files to publish`);
  }
  return entries;
}

/**
 * tar.gz of the app directory, entries prefixed `{appId}/`.
 *
 * Built by `Bun.Archive` from bytes we collected ourselves, which is why the excludes
 * above are code rather than `tar --exclude` patterns: the last `tar` spawn in the repo
 * is gone, and with it the shell-shaped failure modes (a `tar` that is missing, or is
 * bsdtar rather than GNU, or synthesizes AppleDouble members for xattr-bearing files).
 *
 * Two shape differences from what `tar czf` used to emit, neither of which the far end
 * cares about: the archive carries regular-file entries only (no directory members — a
 * path-creating extractor makes the directories), and mode is a uniform 0644 (app source
 * is text; nothing here is executable). The gzip stream is **not** byte-deterministic
 * either way — an mtime from the current clock goes into it — so two archives of
 * identical source still hash differently. That is fine for the freeze-and-ship model
 * (`publish-staging.ts`): the artifact digest attests *these exact frozen bytes*, and
 * source-drift detection uses `computeSourceHash` over `src/` content, never a re-tar
 * comparison.
 */
export async function packageAppTarball(appId: string, appDir: string): Promise<Buffer> {
  const files = await collectAppFiles(appDir);
  const bytes = await new Bun.Archive(files, { compress: 'gzip' }).bytes();
  return Buffer.from(bytes);
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
  if (result.success) notePublishedVersion(appId, version);
  return result;
}
