// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-dev.
 *
 * Provides dev tools (compile, typecheck, deploy) as top-level exports.
 * Requires "yaar-dev" in app.json bundles field to import.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devHeaders(): Record<string, string> {
  const t = (window as any).__YAAR_TOKEN__ || '';
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['X-Iframe-Token'] = t;
  return h;
}

async function devPost<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/dev/${action}`, {
    method: 'POST',
    headers: devHeaders(),
    body: JSON.stringify(body),
    // Compiles can be slow, but a hung server must not leave the app awaiting forever
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => null);
  // Error routes (403/400/413) return bare { error } — normalize to the
  // declared result shape so callers can rely on `success` being present.
  if (!res.ok && (json === null || typeof json !== 'object' || !('success' in json))) {
    const msg = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    return { success: false, error: msg, errors: [msg], diagnostics: [msg] } as T;
  }
  return json as T;
}

export function compile(path: string, opts?: { title?: string }) {
  return devPost<{
    success: boolean;
    previewUrl?: string;
    errors?: string[];
    /** Extracted manifest key names — null when the app registers no protocol. */
    protocol?: { commands: string[]; state: string[] } | null;
  }>('compile', {
    path,
    ...opts,
  });
}

export function typecheck(path: string) {
  return devPost<{ success: boolean; diagnostics: string[] }>('typecheck', { path });
}

export function deploy(
  path: string,
  opts: {
    appId: string;
    name?: string;
    icon?: string;
    description?: string;
    permissions?: string[];
    /** Commit message for the history snapshot this deploy records. */
    message?: string;
    /**
     * Ship without type checking. Deploy type checks first and refuses on errors —
     * this states you know, and want it anyway.
     */
    skipTypecheck?: boolean;
    /**
     * Ship a manifest that drops commands the installed app currently has. Deploy
     * compares protocols first and refuses shrink — this states you know, and
     * want it anyway.
     */
    allowProtocolShrink?: boolean;
  },
) {
  return devPost<{
    success: boolean;
    appId?: string;
    name?: string;
    icon?: string;
    error?: string;
    /** Present when the deploy was refused by the protocol shrink gate. Counts are commands. */
    protocolShrink?: { before: number; after: number; missing: string[] };
  }>('deploy', { path, ...opts });
}

// ── Version history ────────────────────────────────────────────────────────
// Every deploy is snapshotted into a per-app shadow git repo, so a bad deploy is
// undoable. `appId` defaults to the calling app; naming another app requires the
// caller to be a bundled app.

interface AppCommit {
  hash: string;
  shortHash: string;
  /** Unix ms. */
  timestamp: number;
  message: string;
}

/** Commits for an app, newest first. */
export function gitHistory(appId?: string, opts?: { limit?: number }) {
  return devPost<{ success: boolean; commits?: AppCommit[]; error?: string }>('git-history', {
    appId,
    ...opts,
  });
}

/**
 * Diff an app's current files.
 *
 * `against: 'snapshot'` (default) compares against a commit in the app's own
 * history — "what changed since the last deploy". `against: 'repo'` compares
 * against the user's git repo — "what has this app changed relative to what the
 * user committed" — and works only for bundled apps.
 */
export function gitDiff(appId?: string, opts?: { ref?: string; against?: 'snapshot' | 'repo' }) {
  return devPost<{
    success: boolean;
    diff?: string;
    files?: string[];
    against?: 'snapshot' | 'repo';
    ref?: string;
    truncated?: boolean;
    error?: string;
  }>('git-diff', { appId, ...opts });
}

/**
 * Roll an app back to an earlier commit and rebuild it. The current state is
 * snapshotted first, so a restore is itself undoable.
 */
export function gitRestore(appId: string, ref: string) {
  return devPost<{
    success: boolean;
    appId?: string;
    ref?: string;
    files?: string[];
    recompiled?: boolean;
    compileError?: string;
    error?: string;
  }>('git-restore', { appId, ref });
}

/** Snapshot an app's current state as a commit — e.g. before a risky change. */
export function gitCheckpoint(appId?: string, opts?: { message?: string }) {
  return devPost<{ success: boolean; commits?: AppCommit[]; error?: string }>('git-checkpoint', {
    appId,
    ...opts,
  });
}

export async function bundledLibraries(name?: string) {
  const url = name
    ? `/api/dev/bundled-libraries?lib=${encodeURIComponent(name)}`
    : '/api/dev/bundled-libraries';
  const res = await fetch(url, { headers: devHeaders() });
  return res.json();
}
