/**
 * The phone the server runs on, reached through Termux:API.
 *
 * Started once after the port is settled (a notification's tap action names it) and
 * never fatal: off Android, or on a phone without Termux:API, this does nothing at all.
 * The pieces:
 *
 * - `native-notifications.ts` — the desktop's notifications, approvals, questions and
 *   finished turns, mirrored into the Android shade while nobody is looking at the desktop.
 * - the real clipboard, without the browser's focus rule — read by `features/user/clipboard.ts`.
 * - `shareFile` — Android's share sheet, behind `invoke { action: 'share' }` on storage.
 */

import { getBroadcastCenter } from '../../session/broadcast-center.js';
import { isUserWatching, onPresenceChange } from '../../session/client-presence.js';
import { IS_REMOTE } from '../../config.js';
import { getRemoteInfo } from '../../lifecycle.js';
import { localTlsDesktopOrigin } from '../../http/local-tls.js';
import { NativeNotificationBridge } from './native-notifications.js';
import { getTermux, wantsTermuxApi } from './termux.js';

export { getTermux } from './termux.js';

let unsubscribe: (() => void)[] = [];

/**
 * The desktop, as a tap should open it — with the remote token when the desktop needs one.
 * The local TLS socket under `YAAR_TERMUX_HTTPS=1`, the launcher's own choice (see
 * `scripts/dev/start-termux.sh`): a tap must land on the origin the home-screen app lives on.
 */
function desktopUrl(port: number): string {
  const tlsOrigin = process.env.YAAR_TERMUX_HTTPS === '1' ? localTlsDesktopOrigin() : null;
  const base = tlsOrigin ? `${tlsOrigin}/` : `http://localhost:${port}/`;
  const token = IS_REMOTE ? getRemoteInfo()?.token : null;
  return token ? `${base}#remote=${token}` : base;
}

export async function startAndroidIntegration(port: number): Promise<void> {
  if (!wantsTermuxApi()) return;
  const termux = await getTermux();
  if (!termux) return;

  const bridge = new NativeNotificationBridge({
    termux,
    isUserWatching,
    desktopUrl: () => desktopUrl(port),
  });
  unsubscribe = [
    getBroadcastCenter().observe((sessionId, event) => bridge.handle(sessionId, event)),
    onPresenceChange((sessionId) => bridge.presenceChanged(sessionId)),
  ];
}

export function stopAndroidIntegration(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
}

/**
 * Open Android's share sheet for a file already on disk. The user picks the target, so
 * the sheet is itself the consent step; what this refuses is only "there is no sheet".
 */
export async function shareFile(
  absolutePath: string,
  title?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const termux = await getTermux();
  if (!termux) {
    return {
      ok: false,
      error:
        'Sharing needs Termux:API on the phone running YAAR: `pkg install termux-api` in ' +
        'Termux, plus the Termux:API app from the same store Termux came from.',
    };
  }
  return (await termux.shareFile(absolutePath, { title }))
    ? { ok: true }
    : { ok: false, error: 'Termux:API did not open the share sheet.' };
}
