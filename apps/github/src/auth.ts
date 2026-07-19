/**
 * GitHub sign-in via the OAuth Device Authorization Grant (RFC 8628) — the same
 * flow `gh auth login` uses. No PAT, no client secret, no redirect/callback: we
 * request a short user code, the user authorizes it in their browser, and we
 * poll for the resulting access token. All HTTP goes through YAAR's proxy via
 * `httpFetch`, so there is no CORS concern and no new server capability is required.
 */
import { httpFetch, wait, errMsg, showToast } from '@bundled/yaar';
import { state, setState } from './store';
import { writeToken, readClientId } from './storage';
import { fetchUser } from './api';

/**
 * YAAR's registered OAuth App Client ID (with "Enable Device Flow" checked).
 * The client id is public — it is safe to bake in and commit (this is exactly
 * how the `gh` CLI ships GitHub's own client id). A per-install override can
 * still be saved at storage `github/client_id`; Settings prompts for one only
 * when both this and the override are empty.
 */
const BUILTIN_CLIENT_ID = 'Ov23lioHjopCq7LX6Awl';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
// `repo` covers the app's writes (issues/comments/state) on public and private
// repos; `read:user` lets us show who is signed in.
const SCOPE = 'repo read:user';

interface FormReply {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
  raw: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * POST a form-encoded body to a GitHub device endpoint and parse the reply.
 * GitHub returns JSON when `Accept: application/json` is honored but falls back
 * to form-urlencoded otherwise, so handle both shapes.
 */
async function postForm(url: string, params: Record<string, string>): Promise<FormReply> {
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    // Transport/domain failure — the verb path used to return a non-ok envelope
    // here; now it rejects. Keep the message useful for the sign-in error banner.
    throw new Error(`Could not reach GitHub: ${errMsg(e)}`);
  }

  const text = (await res.text()).trim();

  let data: Record<string, unknown> = {};
  if (text.startsWith('{') || text.startsWith('[')) {
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
  }
  if (Object.keys(data).length === 0 && text) {
    // form-urlencoded fallback (e.g. device_code=...&user_code=...)
    try { new URLSearchParams(text).forEach((v, k) => { data[k] = v; }); } catch { /* ignore */ }
  }

  return { status: res.status, ok: res.ok, data, raw: text };
}

/** Resolve the client id: per-install override first, then the built-in default. */
export async function resolveClientId(): Promise<string> {
  const stored = await readClientId();
  return (stored || BUILTIN_CLIENT_ID).trim();
}

function resetAuth(status: 'idle' | 'authed'): void {
  setState('auth', { status, userCode: '', verificationUri: '', error: '' });
}

/**
 * Begin the device flow. Resolves once we have a user code to display (status
 * becomes `pending`); the token poll continues in the background and drives the
 * store to `authed` / `error`. Returns the code + URL so a caller (e.g. the app
 * agent) can relay them to the user.
 */
export async function startDeviceLogin(): Promise<{ userCode: string; verificationUri: string }> {
  try {
    const clientId = await resolveClientId();
    if (!clientId) throw new Error('No OAuth App Client ID configured. Add one in Settings.');

    setState('auth', { status: 'starting', userCode: '', verificationUri: '', error: '' });
    const { status, data, raw } = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE });
    const deviceCode = str(data.device_code);
    const userCode = str(data.user_code);
    const verificationUri = str(data.verification_uri) || 'https://github.com/login/device';

    if (!deviceCode || !userCode) {
      // Surface GitHub's own error so setup problems are diagnosable, e.g.
      // "Not Found" (unknown client_id) or "device_flow_disabled" (checkbox off).
      const detail =
        str(data.error_description) || str(data.error) || raw.slice(0, 160) || `HTTP ${status}`;
      throw new Error(`GitHub sign-in failed: ${detail}`);
    }

    const interval = typeof data.interval === 'number' ? data.interval : 5;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 900;
    setState('auth', { status: 'pending', userCode, verificationUri, error: '' });

    // Poll in the background; the UI reacts to store changes.
    void pollForToken(clientId, deviceCode, interval, expiresIn).catch((e) => {
      setState('auth', { status: 'error', userCode: '', verificationUri: '', error: errMsg(e) });
    });

    return { userCode, verificationUri };
  } catch (e) {
    setState('auth', { status: 'error', userCode: '', verificationUri: '', error: errMsg(e) });
    throw e;
  }
}

async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<void> {
  let waitMs = Math.max(interval, 1) * 1000;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await wait(waitMs);
    // The user cancelled or restarted the flow while we were waiting.
    if (state.auth.status !== 'pending') return;

    // A blip while polling is not a sign-in failure — the user may still be
    // typing the code. Under the old verb transport these surfaced as an empty
    // reply and the loop simply retried; keep that behavior now that they throw.
    let data: Record<string, unknown>;
    try {
      ({ data } = await postForm(TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: GRANT_TYPE,
      }));
    } catch {
      continue;
    }

    const accessToken = str(data.access_token);
    if (accessToken) {
      await writeToken(accessToken);
      await refreshUser();
      resetAuth('authed');
      showToast('Signed in to GitHub', 'success');
      return;
    }

    const err = str(data.error);
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { waitMs += 5000; continue; }
    if (err === 'expired_token') throw new Error('The code expired before you authorized it. Please try again.');
    if (err === 'access_denied') throw new Error('Sign-in was denied.');
    if (err) throw new Error(str(data.error_description) || err);
  }

  throw new Error('Sign-in timed out. Please try again.');
}

/** Fetch and store the authenticated user; on 401 the token is stale, so sign out. */
export async function refreshUser(): Promise<void> {
  try {
    const user = await fetchUser();
    setState('user', user);
  } catch (e) {
    if ((e as { status?: number }).status === 401) {
      await writeToken('');
      setState('user', null);
      resetAuth('idle');
      return;
    }
    // Non-fatal (rate limit, offline): keep the token, just skip the avatar.
    setState('user', null);
  }
}

/** Abandon an in-progress device flow (stops the background poll on next tick). */
export function cancelLogin(): void {
  resetAuth('idle');
}

/** Clear the stored token and signed-in user. */
export async function signOut(): Promise<void> {
  await writeToken('');
  setState('user', null);
  resetAuth('idle');
  showToast('Signed out of GitHub', 'success');
}
