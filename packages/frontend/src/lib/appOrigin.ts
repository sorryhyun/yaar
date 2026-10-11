/**
 * Which origin an installed app's iframe is served from, locally.
 *
 * Under app-origin isolation the desktop lives on `localhost` and installed apps do not.
 * There are two places they can go:
 *
 * - **Shared** — the `127.0.0.1` alias on the desktop's port. One origin for every app,
 *   so apps are kept from the desktop but not from each other, and share one renderer.
 * - **Per-app** — `<appId>.localhost`, when the server marks a window `perAppOrigin`
 *   (`loopback-subdomain`, `docs/proposals/app_site_isolation_proposal.md`). A site of its
 *   own, so its own process, and no sibling can reach into its frame.
 *
 * Only the browser can derive either: the desktop's port is the document's, which is not
 * necessarily the API's. And only the browser knows whether it resolves `*.localhost` —
 * Chromium does it itself, a WebView that hands the name to the system resolver may not.
 * So the first per-app window asks once per load ({@link decideAppOriginPlan}): an answer
 * from `probe.localhost` means per-app origins work here; anything else falls back to the
 * shared alias, which the server still accepts. That fallback is a silent security
 * downgrade, so the outcome is put where it can be seen — `data-app-origins` on `<html>`,
 * and the console.
 */

export type AppOriginPlan = 'per-app' | 'shared';

/** The label the probe asks for. Any label would do: every `*.localhost` is app side. */
const PROBE_LABEL = 'probe';
/** Loopback answers in milliseconds; a name that never resolves is what this bounds. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Set on an isolated app's `<iframe>` to the origin it was served from, so a post to it
 * can name that origin exactly (`iframe-bridge/target.ts`) instead of `'*'`.
 */
export const IFRAME_ORIGIN_DATA_ATTR = 'data-yaar-origin';

/** One DNS label, the rule the server holds app ids to (`appIdRefusal`). */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

let plan: AppOriginPlan | null = null;
let deciding: Promise<AppOriginPlan> | null = null;
const listeners = new Set<() => void>();

function portSuffix(): string {
  const { port } = window.location;
  return port ? `:${port}` : '';
}

/**
 * The shared app origin — the `127.0.0.1` alias on the current port — or null when the
 * desktop isn't on `localhost` (a LAN IP, a remote tunnel, or already on `127.0.0.1`),
 * where there is no sibling to derive.
 *
 * The assignment is pinned, not symmetric: the desktop lives on `localhost` and apps on
 * `127.0.0.1`. The server enforces exactly that — it refuses a token-less request carrying
 * the app origin, and redirects a desktop document that lands there back to localhost — so
 * an app must never be served onto the desktop's own name. Both resolve to the same
 * socket; only the browser-visible origin changes.
 */
export function sharedAppOrigin(): string | null {
  const { protocol, hostname } = window.location;
  if (hostname !== 'localhost') return null;
  return `${protocol}//127.0.0.1${portSuffix()}`;
}

/**
 * `<appId>.localhost` on the desktop's scheme and port, or null when the desktop isn't on
 * `localhost` or the id cannot be a hostname label. The server has refused such ids since
 * the per-app origin was planned, but an app installed before that may still carry one;
 * it keeps the shared alias.
 */
export function appOriginFor(appId: string): string | null {
  const { protocol, hostname } = window.location;
  if (hostname !== 'localhost') return null;
  if (!LABEL_RE.test(appId) || appId.startsWith('xn--')) return null;
  return `${protocol}//${appId}.localhost${portSuffix()}`;
}

/**
 * The origin to serve an isolated app from, locally: its own when the plan is per-app and
 * the id can be a label, else the shared alias. Null off `localhost`.
 */
export function localAppOrigin(appId: string | undefined, perApp: boolean): string | null {
  return (perApp && appId ? appOriginFor(appId) : null) ?? sharedAppOrigin();
}

/** The plan this load settled on, or null while it has not been decided. */
export function getAppOriginPlan(): AppOriginPlan | null {
  return plan;
}

export function subscribeAppOriginPlan(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Does `probe.localhost` reach this server, and say the per-app mode is in force? */
async function probe(): Promise<boolean> {
  const url = `${window.location.protocol}//${PROBE_LABEL}.localhost${portSuffix()}/health`;
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { originBoundary?: unknown } | null;
    return body?.originBoundary === 'loopback-subdomain';
  } catch {
    return false;
  }
}

/**
 * Decide, once per load, whether per-app origins work in this client. Every later call
 * gets the same answer — two windows of one session must not disagree about it.
 */
export function decideAppOriginPlan(): Promise<AppOriginPlan> {
  if (plan) return Promise.resolve(plan);
  deciding ??= (async () => {
    const decided: AppOriginPlan =
      window.location.hostname === 'localhost' && (await probe()) ? 'per-app' : 'shared';
    plan = decided;
    document.documentElement.dataset.appOrigins = decided;
    if (decided === 'per-app') {
      console.info('[appOrigin] installed apps each run on their own <appId>.localhost origin');
    } else {
      console.warn(
        '[appOrigin] *.localhost did not answer, so installed apps share the 127.0.0.1 ' +
          'origin: kept from the desktop, but not from each other.',
      );
    }
    for (const listener of listeners) listener();
    return decided;
  })();
  return deciding;
}

/** Forget the decision. Tests only. */
export function resetAppOriginPlan(): void {
  plan = null;
  deciding = null;
  delete document.documentElement.dataset.appOrigins;
}
