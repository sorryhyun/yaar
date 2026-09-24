/**
 * Whether Android is still allowed to kill this server for being a child process.
 *
 * Termux runs YAAR as a child of the Termux app, and Android 12+ treats such children as
 * "phantom processes": it kills them outright (SIGKILL — no log line, no shutdown) when the
 * app is in the background and they use too much CPU, or when there are more than 32 of
 * them across all apps. YAAR is exactly that shape while the user looks at the desktop in
 * Chrome: a Bun server, a Claude CLI per agent, a companion Chromium, and `tsc` on every
 * compile. The only fix is the user's — Developer options → "Disable child process
 * restrictions" (Android 14+), or the same flag set over adb on 12L/13.
 *
 * That toggle is a feature-flag override stored in a system property, which an app uid
 * can read with `getprop`, so this can tell the two states apart. While the restrictions
 * are on, the session gets fewer monitors (each monitor is one more agent process) and
 * the Configurations app says why.
 *
 * Unknown stays unknown: a `getprop` that fails is not evidence the restrictions are on,
 * and capping monitors on a guess would be a restriction with no stated reason.
 */

import { MAX_MONITORS } from '@yaar/shared';

/** The toggle's flag, as `FeatureFlagUtils` stores a persistent override of it. */
const FLAG_PROP = 'persist.sys.fflag.override.settings_enable_monitor_phantom_procs';

/** Android 12 is where phantom-process killing arrived. */
const FIRST_RESTRICTED_SDK = 31;

/** Monitors a session may have while Android can still kill the server's children. */
export const RESTRICTED_MAX_MONITORS = 2;

/** Long enough that minting a monitor rarely spawns, short enough to notice a flip. */
const CACHE_MS = 30_000;

export type ChildProcessRestrictions =
  /** Not Android, or an Android older than 12 — there is nothing to restrict. */
  | 'not-applicable'
  /** The user turned the restrictions off. */
  | 'disabled'
  /** Android's default: background children can be killed. */
  | 'enabled'
  /** `getprop` did not answer. */
  | 'unknown';

export interface ChildProcessLimitStatus {
  restrictions: ChildProcessRestrictions;
  /** `ro.build.version.sdk`, when read. */
  sdk?: number;
  /** The monitor cap this puts on every session. */
  maxMonitors: number;
}

let cached: { at: number; status: ChildProcessLimitStatus } | null = null;

function getprop(name: string): string | null {
  try {
    const proc = Bun.spawnSync(['getprop', name], { stdout: 'pipe', stderr: 'ignore' });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** Classify from the two properties. Pure, so the rules are testable off a phone. */
export function classifyRestrictions(
  sdkProp: string | null,
  flagProp: string | null,
): ChildProcessRestrictions {
  const sdk = sdkProp ? Number.parseInt(sdkProp, 10) : NaN;
  if (!Number.isFinite(sdk)) return 'unknown';
  if (sdk < FIRST_RESTRICTED_SDK) return 'not-applicable';
  if (flagProp === null) return 'unknown';
  // Unset is Android's default, which is restricted. So is an explicit `true`.
  return flagProp.toLowerCase() === 'false' ? 'disabled' : 'enabled';
}

function probe(): ChildProcessLimitStatus {
  if (process.platform !== 'android') {
    return { restrictions: 'not-applicable', maxMonitors: MAX_MONITORS };
  }
  const sdkProp = getprop('ro.build.version.sdk');
  const restrictions = classifyRestrictions(sdkProp, getprop(FLAG_PROP));
  const sdk = sdkProp ? Number.parseInt(sdkProp, 10) : undefined;
  return {
    restrictions,
    ...(sdk !== undefined && Number.isFinite(sdk) ? { sdk } : {}),
    maxMonitors: restrictions === 'enabled' ? RESTRICTED_MAX_MONITORS : MAX_MONITORS,
  };
}

/** The current status, re-probed at most every 30s — or now, with `fresh`. */
export function getChildProcessLimit(fresh = false): ChildProcessLimitStatus {
  const now = Date.now();
  if (fresh || !cached || now - cached.at > CACHE_MS) cached = { at: now, status: probe() };
  return cached.status;
}

/** How many monitors a session may have right now. */
export function effectiveMaxMonitors(): number {
  return getChildProcessLimit().maxMonitors;
}
