/**
 * Delegated storage grants — a file reference handed to an app carries the key to it.
 *
 * ── The hole this closes ──
 *
 * A monitor (or session) agent is unconfined: it reads any `yaar://storage/…`. An app
 * iframe is an `app` principal, confined to the `permissions` its app.json declares
 * (http/access.ts). So the most natural thing an agent can do — open an app and tell it
 * which file to work on — fails at the door:
 *
 *   invoke('yaar://windows/editor', { action: 'app_command', command: 'openFile',
 *                                     params: { path: 'yaar://storage/files/notes.md' } })
 *   → the app calls read('yaar://storage/files/notes.md')
 *   → 403 Not permitted: read yaar://storage/files/notes.md
 *
 * The agent has the file, names the file, and the app it named it *to* cannot open it.
 * The only escape today is the convention in the monitor prompt — `copy` the bytes into
 * `media/{producer}/` first — which duplicates the file, breaks write-back, and only
 * works for apps that happen to declare `yaar://storage/media/`. Most declare either
 * everything (`yaar://storage/`) or nothing.
 *
 * ── The rule ──
 *
 * When a **more privileged principal** names a storage file in a payload the server is
 * about to hand to an app, that exact file becomes readable by that app, in that window,
 * for as long as the window lives. This is delegation, not escalation: the grant can
 * never exceed what the delegator already had, and the delegator is naming one file on
 * purpose.
 *
 * It generalises a rule that already existed for exactly one case — `documentUri` in
 * `http/iframe-tokens.ts`, "an iframe may always read the document it was told to
 * render" — from *the window's own URL* to *any reference the server passes inward*.
 *
 * ── Four things keep it narrow ──
 *
 * 1. **Only a non-app caller delegates** (`mayDelegateGrants`). An app agent or an
 *    iframe naming a path is not delegation, it is an app asking for a file it was
 *    never given; those callers get nothing. This is the load-bearing check — without
 *    it, `invoke('yaar://windows/x', {action:'app_command', params:{path:'…'}})` from
 *    any app that declares `yaar://windows/` is a self-grant for the whole storage tree.
 * 2. **Exact files, never prefixes.** A URI ending in `/` is a *prefix* to `uriMatches`,
 *    so a delegated directory would be a foothold in the namespace that hosts it.
 *    Directories are refused; so is anything containing `..`, which names no resource.
 * 3. **`read` only.** Write-back is a decision the user's app.json makes, not one an
 *    agent makes in passing.
 * 4. **Scoped to the window and revoked with it** (`WindowStateRegistry`), so a grant
 *    cannot outlive the interaction that created it, and survives an iframe remount —
 *    the token is re-minted on reconnect and would otherwise silently lose it.
 */

import { getAgentRole, getAppId } from '../../agents/agent-context.js';
import type { PermissionEntry } from '../../http/access.js';

/** Ceiling on grants minted from one payload — a runaway walk mints nothing sensible. */
const MAX_DELEGATED_URIS = 16;
/** How deep into a nested payload the walk looks for URIs. */
const MAX_DEPTH = 6;

/**
 * A storage URI embedded in a larger string (a query parameter, a sentence).
 *
 * The character class stops at anything that routinely *follows* a URI rather than
 * belongs to it — whitespace, quotes, `&`, `?`, `#`, brackets. A path containing one of
 * those is simply not matched, which grants nothing: the status quo, not a hole. The
 * whole-string fast path below covers the common case (the value *is* the URI) with no
 * character restrictions at all, so a filename with a space or a comma still works when
 * it is passed as its own parameter.
 */
const EMBEDDED_STORAGE_URI =
  /yaar:\/\/(?:storage|apps\/[A-Za-z0-9._-]+\/storage)\/[^\s"'`<>\\|&?#,;)\]}]+/g;

const STORAGE_URI_PREFIX = /^yaar:\/\/(?:storage|apps\/[A-Za-z0-9._-]+\/storage)\//;

/**
 * May the current caller hand its own reach to an app?
 *
 * Two independent facts say "this is an app talking", and both are checked because
 * neither context sets the other: an app *agent* carries `role: 'app'` and no appId
 * (agent-session.ts), while an app *iframe* calling `POST /api/verb` carries an appId
 * and no role at all (http/routes/verb.ts). A monitor or session agent has neither, and
 * a host-initiated path (restore, a REST route) runs outside any agent context, which is
 * the desktop acting as the user.
 */
export function mayDelegateGrants(): boolean {
  return getAgentRole() !== 'app' && getAppId() === undefined;
}

/** Normalize one candidate to the URI a grant may name, or null if it may not. */
function asDelegatableUri(raw: string): string | null {
  const uri = raw.trim().replace(/[.,;:!?)\]}>'"]+$/, '');
  if (!STORAGE_URI_PREFIX.test(uri)) return null;
  // A trailing slash makes the entry a prefix (uriMatches), which would hand the app
  // the whole subtree rather than the file it was told about.
  if (uri.endsWith('/')) return null;
  // A traversing path names no resource; `canonicalStorageUri` refuses it at the gate
  // anyway, so recording one only makes the grant list lie.
  if (uri.split('/').includes('..')) return null;
  return uri;
}

/** Pull every delegatable storage URI out of one string. */
function urisInString(value: string, out: Set<string>): void {
  const whole = asDelegatableUri(value);
  if (whole) {
    out.add(whole);
    return;
  }
  for (const candidate of [value, value.includes('%') ? safeDecode(value) : null]) {
    if (!candidate) continue;
    for (const match of candidate.matchAll(EMBEDDED_STORAGE_URI)) {
      const uri = asDelegatableUri(match[0]);
      if (uri) out.add(uri);
      if (out.size >= MAX_DELEGATED_URIS) return;
    }
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null; // malformed escape — nothing to read out of it
  }
}

/**
 * Every storage URI a payload names, at any depth.
 *
 * Walks strings, arrays and plain objects. Keys are walked as well as values: an app
 * that takes `{ 'yaar://storage/a.md': {...} }` is naming a file just as much as one
 * that takes `{ path: 'yaar://storage/a.md' }`.
 */
export function collectDelegatableUris(value: unknown, depth = 0, out = new Set<string>()) {
  if (out.size >= MAX_DELEGATED_URIS || depth > MAX_DEPTH) return out;
  if (typeof value === 'string') {
    urisInString(value, out);
  } else if (Array.isArray(value)) {
    for (const item of value) collectDelegatableUris(item, depth + 1, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      urisInString(key, out);
      collectDelegatableUris(item, depth + 1, out);
    }
  }
  return out;
}

/**
 * The grants a payload delegates, or `[]` when the caller may not delegate.
 *
 * `read` only, one entry per exact file — see the header for why each narrowing is
 * there rather than the obvious wider thing.
 */
export function grantsFromPayload(payload: unknown): PermissionEntry[] {
  if (!mayDelegateGrants()) return [];
  return [...collectDelegatableUris(payload)].map((uri) => ({ uri, verbs: ['read' as const] }));
}
