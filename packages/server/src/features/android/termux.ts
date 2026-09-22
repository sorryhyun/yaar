/**
 * Whether this server can reach the phone it runs on through Termux:API, and the one
 * client every Android feature shares.
 *
 * Optional in every sense. Termux:API is a separate app *and* a separate package, and
 * most phones running `make termux` have neither — so its absence changes nothing: the
 * notification bridge never starts, the clipboard goes through the browser as it does
 * everywhere else, and `share` says what is missing. `YAAR_TERMUX_API=0` turns it off even
 * when installed.
 *
 * Probed once, in the background, at startup (`startAndroidIntegration`), so the answer
 * is usually settled before anyone asks. The probe is a real call rather than a `which`,
 * because the package without the app hangs instead of failing — see
 * `@yaar/lib/termux`'s header.
 */

import { TermuxApi } from '@yaar/lib/termux';
import { createLogger } from '../../observability/log.js';

const log = createLogger('termux');

let api: TermuxApi | null = null;
let reported = false;

/** Android, and not turned off. Says nothing yet about whether Termux:API is installed. */
export function wantsTermuxApi(): boolean {
  return process.platform === 'android' && process.env.YAAR_TERMUX_API !== '0';
}

/**
 * The Termux:API client, or null when there is none to use. Resolves quickly after the
 * first probe; the first call itself may take a cold start of the Termux:API app.
 */
export async function getTermux(): Promise<TermuxApi | null> {
  if (!wantsTermuxApi()) return null;
  // The package puts the commands on PATH. Without them the probe would only spawn-fail,
  // and saying "install termux-api" once is more useful than an error per call.
  if (!Bun.which('termux-battery-status')) {
    if (!reported) {
      reported = true;
      log.info('Termux:API not installed; notifications, clipboard and share stay in the browser', {
        hint: 'pkg install termux-api, plus the Termux:API app from the same store as Termux',
      });
    }
    return null;
  }
  api ??= new TermuxApi();
  const ready = await api.available();
  if (!reported) {
    reported = true;
    if (ready) log.info('Termux:API available');
    else
      log.warn('termux-api is installed but the Termux:API app did not answer', {
        hint: 'install the Termux:API app from the same source as Termux (F-Droid or GitHub)',
      });
  }
  return ready ? api : null;
}
