/**
 * URI parsing and on-disk layout for app-scoped subresources.
 *
 * These are the only place that knows how `yaar://apps/{appId}/storage/...` and
 * `yaar://apps/{appId}/db/...` decompose, and where an app's files live on disk.
 * `register.ts` uses them to decide which resource module handles a request; the
 * app-agent door (`mcp/app-agent`) imports `scopedAppStoragePath` for the same layout.
 */

import { validateRelativePath } from '../utils.js';

/**
 * The on-disk home of an app's scoped storage: `storage/apps/{appId}/{path}`.
 *
 * Single-sourced because two different doors reach the same files with different
 * keys: this one takes the appId from the URI (the caller names it, and the access
 * chokepoint / URI registry has already decided whether they may), while
 * `mcp/app-agent` takes it from the caller's own window context (the appId cannot
 * be named, so it cannot be forged). The layouts must not drift apart; the
 * dispatch around them is deliberately not shared — see the divergence note in
 * `mcp/app-agent/index.ts`.
 *
 * The leading-slash strip is a no-op on this side: `parseAppStoragePath` runs
 * `validateRelativePath`, which rejects a leading "/" outright. It is what
 * `scopedAppStoragePath` does with the app-agent door's raw tool argument.
 *
 * This function does not guard traversal — the path it is handed must already be
 * confined. Callers holding a raw, caller-supplied path want `scopedAppStoragePath`.
 */
export function appStoragePath(appId: string, relativePath: string): string {
  return `apps/${appId}/${relativePath.replace(/^\//, '')}`;
}

/**
 * `appStoragePath` plus the traversal guard, for callers whose path arrives unvalidated.
 * Returns null when the path would leave `apps/{appId}/`.
 *
 * The verbs door validates in `parseAppStoragePath`, because a URI carries its own appId
 * and the check belongs with the parse. The app-agent door has no URI and no parse step —
 * it takes the appId from the caller's window and the path straight off a tool argument —
 * so its guard lives here, next to the layout it protects. Without it, `storageRead`'s
 * only containment is `STORAGE_DIR`, and `apps/notes/../devtools/secrets.json` normalizes
 * to a path that is still inside `STORAGE_DIR` and therefore allowed.
 *
 * A leading "/" is stripped rather than rejected: the app-agent door has always accepted
 * one, it cannot escape the subtree, and this fix is meant to close the traversal only.
 * That is the one place the two doors' path rules differ.
 */
export function scopedAppStoragePath(appId: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/^\/+/, '');
  if (validateRelativePath(cleaned)) return null;
  return appStoragePath(appId, cleaned);
}

/**
 * Parse `yaar://apps/{appId}/storage/{path}` → { appId, path } or null.
 * Rejects paths containing `..` segments to prevent cross-app traversal.
 */
export function parseAppStoragePath(uri: string): { appId: string; path: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/storage(?:\/(.*))?$/);
  if (!match) return null;
  const path = match[2] ?? '';
  if (validateRelativePath(path)) return null;
  return { appId: match[1], path };
}

/**
 * Parse `yaar://apps/{appId}/agents[/{personaId}]` → { appId, personaId? } or null.
 *
 * The persona id is not validated here — a syntactically fine id that no persona
 * was spawned under is a 404 from the resource, not a parse failure, and the
 * resource is where the character set is enforced (`PERSONA_ID_RE`) so the error
 * can say which rule was broken.
 */
export function parseAppAgentsPath(uri: string): { appId: string; personaId?: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/agents(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  return { appId: match[1], ...(match[2] ? { personaId: match[2] } : {}) };
}

/**
 * Parse `yaar://apps/{appId}/protocol[/{rest}]` → { appId, rest } or null.
 *
 * The tail is returned unsplit on purpose. `/protocol/commands/moveNode` and
 * `/protocol/hamsters` are both syntactically fine here; the resource module decides
 * which sections exist and says so by name, because "no such section — state or
 * commands" is a better answer than the composite's generic unknown-sub-path refusal.
 *
 * Note what this URI is *not*: `yaar://apps/{id}/commands/{key}` stays refused on every
 * verb (`INSTANCE_SUBPATHS` in `register.ts`). The distinction is the one the apps/windows
 * split already draws — `/protocol/commands/{key}` is the *documentation of* a command
 * and belongs to the installed app, while `yaar://windows/{id}/commands/{key}` is the
 * command as something callable right now and belongs to a running window.
 */
export function parseAppProtocolPath(uri: string): { appId: string; rest: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/protocol(?:\/(.*))?$/);
  if (!match) return null;
  return { appId: match[1], rest: (match[2] ?? '').replace(/\/+$/, '') };
}

/**
 * Parse `yaar://apps/{appId}/docs[/{name}]` → { appId, name? } or null.
 *
 * Same division of labor as the protocol parser above: the name is not validated here —
 * a syntactically fine slug no topic answers to is a 404 from the resource, which knows
 * the declared names and can say them; a *malformed* tail (extra segments) is also the
 * resource's refusal, so the error can name the one-topic-per-address rule.
 */
export function parseAppDocsPath(uri: string): { appId: string; rest: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/docs(?:\/(.*))?$/);
  if (!match) return null;
  return { appId: match[1], rest: (match[2] ?? '').replace(/\/+$/, '') };
}

/** Parse `yaar://apps/{appId}/db[/{collection}[/{docId}]]` or null. */
export function parseAppDbPath(
  uri: string,
): { appId: string; collection?: string; docId?: string } | null {
  const match = uri.match(/^yaar:\/\/apps\/([^/]+)\/db(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
  if (!match) return null;
  return { appId: match[1], collection: match[2], docId: match[3] };
}
