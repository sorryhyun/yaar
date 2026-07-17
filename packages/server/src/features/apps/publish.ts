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
import { getIdToken } from '../market/google-auth.js';
import { resolveAppDir } from './roots.js';
import { errMessage } from '../../lib/errors.js';

/** Matches the marketplace's own app id rule; a mismatch is rejected there anyway. */
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

export interface PublishResult {
  success: boolean;
  error?: string;
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
 */
async function packageApp(appId: string, appDir: string): Promise<Buffer> {
  const proc = spawn(
    [
      'tar',
      'czf',
      '-',
      '--exclude',
      `${basename(appDir)}/dist`,
      '-C',
      dirname(appDir),
      basename(appDir),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
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

export async function publishApp(appId: string): Promise<PublishResult> {
  if (!APP_ID_RE.test(appId)) {
    return { success: false, error: `Invalid app id "${appId}".` };
  }

  const appDir = resolveAppDir(appId);
  if (!appDir) return { success: false, error: `App "${appId}" is not installed.` };

  const idToken = await getIdToken().catch((err) => {
    // An expired refresh grant surfaces here as "sign in again" — pass it through
    // rather than flattening it into a generic publish failure.
    throw new Error(errMessage(err));
  });
  if (!idToken) {
    return {
      success: false,
      error: 'Not signed in to Google. Sign in first to publish (yaar://market/account).',
    };
  }

  let tarball: Buffer;
  try {
    tarball = await packageApp(appId, appDir);
  } catch (err) {
    return { success: false, error: `Failed to package "${appId}": ${errMessage(err)}` };
  }

  const form = new FormData();
  form.append('tarball', new Blob([tarball], { type: 'application/gzip' }), `${appId}.tar.gz`);

  let res: Response;
  try {
    res = await fetch(`${MARKET_URL}/api/apps/${appId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
      body: form,
    });
  } catch (err) {
    return { success: false, error: `Could not reach the marketplace: ${errMessage(err)}` };
  }

  const body = (await res.json().catch(() => null)) as {
    detail?: string;
    message?: string;
    commit?: string;
    files?: number;
  } | null;

  if (!res.ok) {
    // FastAPI puts the reason in `detail`; it is the only useful part of a 4xx.
    return {
      success: false,
      error: body?.detail ?? `Publish failed (${res.status}).`,
    };
  }

  return {
    success: true,
    message: body?.message ?? `Published "${appId}".`,
    commit: body?.commit,
    files: body?.files,
  };
}
