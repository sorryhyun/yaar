/**
 * What the compiler bakes into every app's dist/index.html besides the app's own code:
 * the iframe SDK scripts and the design-token stylesheet.
 *
 * Kept here, apart from `compile.ts`, because the build manifest hashes the same bytes
 * (`computeSdkHash`): an app whose dist/ carries an older SDK is stale even though its
 * own src/ never changed. One list, read by both, so the hash cannot miss a script the
 * compiler injects.
 */

import {
  IFRAME_IME_GUARD_SCRIPT,
  IFRAME_AUTOFILL_GUARD_SCRIPT,
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_CONTEXTMENU_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_DEVICE_SDK_SCRIPT,
  IFRAME_TEXT_SELECTION_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_CONSOLE_CAPTURE_SCRIPT,
} from '@yaar/shared';
import { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';

/**
 * Minified SDK scripts cache. Populated lazily on first compile. Only the
 * minified form is cached — the raw form is an array join.
 */
let minifiedSdkScripts: string | null = null;
let sdkHash: string | null = null;

export function getRawSdkScripts(): string {
  return [
    // First — the guard must be listening before any app code registers handlers
    IFRAME_IME_GUARD_SCRIPT,
    IFRAME_AUTOFILL_GUARD_SCRIPT,
    IFRAME_CAPTURE_HELPER_SCRIPT,
    IFRAME_STORAGE_SDK_SCRIPT,
    IFRAME_VERB_SDK_SCRIPT,
    IFRAME_FETCH_PROXY_SCRIPT,
    IFRAME_APP_PROTOCOL_SCRIPT,
    // Baked in rather than injected, because `IframeRenderer` can only inject into a
    // **same-origin** frame and an origin-isolated app (`source: 'user'`) is not one.
    // Without it such an app forwarded none of the shell's reserved shortcuts, so
    // Shift+Tab fell through to the browser's own focus walk inside the frame — the
    // CLI panel never opened and focus moved to the next control instead. Idempotent
    // (`installGuard`), so a bundled app that also gets the injected copy is unharmed.
    IFRAME_CONTEXTMENU_SCRIPT,
    IFRAME_NOTIFICATIONS_SDK_SCRIPT,
    IFRAME_DEVICE_SDK_SCRIPT,
    IFRAME_TEXT_SELECTION_SCRIPT,
    IFRAME_WINDOWS_SDK_SCRIPT,
    IFRAME_CONSOLE_CAPTURE_SCRIPT,
  ].join('\n');
}

export function getSdkScripts(minify: boolean): string {
  if (!minify) return getRawSdkScripts();
  if (minifiedSdkScripts === null) {
    const transpiler = new Bun.Transpiler({ minifyWhitespace: true });
    minifiedSdkScripts = transpiler.transformSync(getRawSdkScripts()).trim();
  }
  return minifiedSdkScripts;
}

/**
 * SHA-256 of everything this module says the compiler bakes in. Hashed from the strings
 * themselves rather than from files under `@yaar/shared`, so it is the same in a source
 * checkout and in the bundled exe, where those files do not exist.
 */
export function computeSdkHash(): string {
  if (sdkHash === null) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(getRawSdkScripts());
    hasher.update('\0');
    hasher.update(YAAR_DESIGN_TOKENS_CSS);
    sdkHash = hasher.digest('hex');
  }
  return sdkHash;
}
