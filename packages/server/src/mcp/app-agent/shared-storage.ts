/**
 * The app agent's door onto the *shared* storage tree (`yaar://storage/...`).
 *
 * ── Why this exists ──
 *
 * `query`/`command`'s `storage/...` argument is rewritten to the caller's own
 * app-scoped tree unconditionally, *before* any permission is consulted. So an app
 * declaring a storage grant — up to and including the full root, which thirteen
 * bundled apps do — had that grant enforced at the verb layer for its **iframe** code
 * and simply unreachable from its **agent**, whose four tools are its entire surface
 * (there is no `invoke(uri)` on this door the way `@bundled/yaar` gives one to app
 * code). Two app agents reported the same failure independently: asked to read a file
 * the monitor had just written to the shared root, they were silently redirected to
 * their own empty storage and answered "file not found" — a declared permission with
 * no door behind it.
 *
 * ── Why a URI and not a second relative spelling ──
 *
 * `storage/x` still means the app's own tree. Apps store their state that way and a
 * grant-holder must not have its own files move out from under it because the manifest
 * grew a line. The shared tree is named the way permissions are written in app.json —
 * `yaar://storage/x` — so what an author declares is what an agent types, and the two
 * trees can never be confused for each other in either direction.
 *
 * ── What is not decided here ──
 *
 * The permission. {@link permissionsAllow} is the same gate the iframe door asks,
 * canonicalization included — which is what keeps a declared `yaar://storage/` from
 * prefix-matching `yaar://storage/apps/{other}/`, i.e. every other app's private tree.
 * This module only names the target and reports the refusal in the app agent's terms.
 */

import { validateRelativePath } from '../../handlers/utils.js';
import { getAppMeta } from '../../features/apps/discovery.js';
import { permissionsAllow } from '../../http/access.js';
import { entryUri, entryVerbs } from '../../http/uri-match.js';
import type { Verb } from '../../handlers/uri-registry.js';

/** The shared storage root, spelled as app.json spells it. */
const SHARED_ROOT = 'yaar://storage';

/**
 * Does this tool argument name the shared tree rather than the app's own?
 *
 * The `yaar://` scheme is what distinguishes them: no relative storage path can start
 * with it, so adding this branch cannot change what an existing `storage/...` argument
 * means.
 */
export function namesSharedStorage(arg: string): boolean {
  return arg === SHARED_ROOT || arg.startsWith(`${SHARED_ROOT}/`);
}

/**
 * The storage-root-relative path a shared URI names — `''` for the root itself — or
 * `null` when it traverses.
 *
 * Confinement is to `STORAGE_DIR`, which is all `storageRead` and friends enforce on
 * their own; the app-scoped door needs a *second* guard on top of that
 * (`scopedAppStoragePath`) because its subtree is narrower than the tree. Here the
 * grant is written against the same tree the paths are resolved in, so the `..` check
 * is only about a path naming a resource at all: `yaar://storage/a/../b` would be
 * permission-checked as one URI and read as another.
 */
export function sharedStoragePath(arg: string): string | null {
  const raw = arg.slice(SHARED_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (raw && validateRelativePath(raw)) return null;
  return raw;
}

/** The canonical URI for a root-relative path, as the caller should spell it back. */
export function sharedStorageUri(path: string): string {
  return path ? `${SHARED_ROOT}/${path}` : SHARED_ROOT;
}

/**
 * May this app perform `verb` on `yaar://storage/{path}`? Returns `null` when it may,
 * and the refusal to hand the model when it may not.
 *
 * The refusal names both trees on purpose. The reported failure was an agent that
 * could not tell "my permission has no route here" from "the file isn't there" — so a
 * refusal says which permission is missing *and* that the app's own storage is a
 * different tree reached by a different spelling, rather than leaving the model to
 * guess which of the two it just failed to reach.
 */
export async function authorizeSharedStorage(
  appId: string,
  path: string,
  verb: Verb,
): Promise<string | null> {
  const uri = sharedStorageUri(path);
  const meta = await getAppMeta(appId);
  if (permissionsAllow(meta?.permissions ?? [], appId, uri, verb)) return null;

  return (
    `not permitted: ${verb} ${uri} — "${appId}" declares no permission covering it. ` +
    `Add "${SHARED_ROOT}/" (or a narrower prefix under it) to "permissions" in app.json. ` +
    `Your own app's storage is a separate tree and needs no permission: ` +
    `"storage/${path}" reads it.`
  );
}

/**
 * A sentence to append when an app-scoped read missed and the shared tree *is*
 * reachable — empty otherwise.
 *
 * This is the other half of the same confusion: `query("storage/report.md")` on a file
 * that lives at the shared root fails with a plain "file not found" naming a path the
 * caller never typed. Naming the reachable alternative is only honest when the app
 * actually holds the grant, so a non-holder is told nothing rather than pointed at a
 * door that would refuse it.
 */
export async function sharedStorageHint(appId: string, path: string, verb: Verb): Promise<string> {
  const denied = await authorizeSharedStorage(appId, path, verb);
  return denied
    ? ''
    : ` The shared storage root is a different tree, and your app holds a permission for it — ` +
        `"${sharedStorageUri(path)}" looks there.`;
}

/**
 * The app's declared entries that name part of the shared tree, for the prompt to
 * render.
 *
 * Presentation only — {@link authorizeSharedStorage} is the gate, and this list is
 * never consulted to admit anything. It filters on the manifest's own spelling
 * (`yaar://storage/...`, minus the `apps/{id}/` subtree, which is a different tree
 * wearing the flat spelling) so an author reads back the line they wrote.
 */
export async function sharedStorageGrants(
  appId: string,
): Promise<{ uri: string; verbs: readonly Verb[] }[]> {
  const meta = await getAppMeta(appId);
  return (meta?.permissions ?? [])
    .filter((entry) => {
      const uri = entryUri(entry);
      return namesSharedStorage(uri) && !uri.startsWith(`${SHARED_ROOT}/apps/`);
    })
    .map((entry) => ({ uri: entryUri(entry), verbs: entryVerbs(entry) }));
}
