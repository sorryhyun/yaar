/**
 * The app agent's storage door — both trees, and what each one costs.
 *
 * **Every app agent holds the door.** The relative `storage/...` spelling and the four
 * `storage:*` built-ins are part of what an app *is*, not something an author opts into,
 * because the two trees they reach are already granted for being an app: its own
 * (`yaar://apps/{id}/storage/`, which needs no permission at all) and the commons
 * (`yaar://storage/shared/`, which `permissionsAllow` grants to every app). An app that
 * cannot modify its own storage from its own agent is missing a capability it already
 * owns everywhere else.
 *
 * One question is left, and {@link authorizeSharedStorage} is where it is asked: given
 * the door, may this app perform *this verb* on *this path* of the **shared** tree? That
 * is `permissionsAllow`, unchanged — so everything past the commons still costs an entry
 * in `app.json`, and a declaration is still not a blanket per-verb grant:
 * `{ uri: "yaar://storage/reports/", verbs: ["read","list"] }` reaches those files and
 * still refuses `storage:write` on them.
 *
 * ── Why the door is not declaration-gated ──
 *
 * It was, briefly: an app declaring nothing under `yaar://storage/` was refused all four
 * built-ins, its own tree included, on the reading that a capability the author never
 * declared is not one the agent should hold. The rule cost more than it bought. An
 * author declares permissions for the *foreign* reach they need, and no manifest ever
 * declared the app's own tree — there is nothing to declare, since it needs no
 * permission — so the gate withdrew a capability from precisely the apps that had done
 * nothing wrong, and did it invisibly: the prompt sections were suppressed under the
 * same predicate, so the agent was not told the door existed and could not tell "not
 * permitted" from "not a thing". Meanwhile the same app's **iframe** wrote that tree
 * freely through `@bundled/yaar`, so the boundary the gate drew was between two halves
 * of one app rather than between an app and anything outside it.
 *
 * What remains of it: a declaration still buys the shared tree beyond the commons, which
 * is where a real boundary is — one app reading another's published output, or the files
 * the user and the monitor keep at the storage root.
 *
 * ── Why the shared door exists ──
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
 * The *matching rule*. {@link permissionsAllow} is the same gate the iframe door asks,
 * canonicalization included — which is what keeps a declared `yaar://storage/` from
 * prefix-matching `yaar://storage/apps/{other}/`, i.e. every other app's private tree.
 * This module names the target and reports the refusal in the app agent's terms; it never
 * re-implements the match.
 *
 * The **iframe** side, entirely. `SELF_GRANTS` (`http/iframe-tokens.ts`), the commons in
 * `permissionsAllow`, and every `POST /api/verb` path are this module's peers, not its
 * dependents — and they are the reason the agent door is spelled the way it is. The two
 * halves of an app now reach the same two trees by default; what differs is only the
 * spelling (`@bundled/yaar` for code, these four calls for a model).
 */

import { validateRelativePath } from '../../handlers/utils.js';
import { getAppMeta } from '../../features/apps/discovery.js';
import { permissionsAllow } from '../../http/access.js';
import { canonicalStorageUri, entryUri, entryVerbs, resolveSelf } from '../../http/uri-match.js';
import type { Verb } from '../../handlers/uri-registry.js';

/** The shared storage root, spelled as app.json spells it. */
const SHARED_ROOT = 'yaar://storage';

/** The namespaced dialect — one app each, rather than the flat tree they all live in. */
const APP_NAMESPACE = 'yaar://apps';

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

/** Where an app-namespace storage URI points, once `self` and the flat tree are resolved. */
export type AppNamespaceStorage =
  /** This app's own tree, as a path under its storage root (`''` is the root itself). */
  | { kind: 'own'; path: string }
  /** Another app's tree, in the flat coordinates its grant is written in. */
  | { kind: 'foreign'; uri: string }
  /** A traversing path: it names no resource, so it must not be matched against one. */
  | { kind: 'invalid' };

/**
 * Read `yaar://apps/{id}/storage/…` — the dialect this door **emits** — as a target, or
 * `null` when the argument is not one.
 *
 * The door reports `yaar://apps/{id}/storage/{path}` on every app-scoped result
 * (`resolvedStorageUri`, and each `(resolved to …)`) and then accepted no such spelling
 * back: it matched neither {@link namesSharedStorage} nor the relative `storage/` prefix,
 * so it fell through to the app protocol and failed as an unknown *state key*. A model
 * that reads a listing and asks for one of its entries by the name it was just shown is
 * doing the one thing the reported URI invites, and this is what makes that work.
 *
 * Both dialects resolve here rather than one being privileged, because they are the same
 * file: `resolveSelf` expands the pronoun and `canonicalStorageUri` flattens the namespace
 * onto the tree on disk — the identical pair, in the identical order, that
 * `permissionsAllow` applies at the gate. Naming the app's *own* id and writing `self`
 * therefore land in the same place, and neither can mean something the gate would read
 * differently.
 *
 * The own/foreign split is here and not at the doors because the two answers belong to
 * different branches: this app's own tree is reached by the relative spelling, which
 * needs no permission at all; another app's is
 * reached by the flat spelling, which {@link authorizeSharedStorage} gates exactly as the
 * verbs door would. Returning the *flat* URI for a foreign target is what keeps that
 * second half honest — the grant is written in those coordinates, so no widening is
 * possible by spelling the request in the other dialect.
 *
 * A sub-path that is not storage at all (`yaar://apps/{id}/protocol`) answers `null` and
 * carries on to the app protocol, which is where it was always going.
 */
export function appNamespaceStorage(arg: string, appId: string): AppNamespaceStorage | null {
  if (!arg.startsWith(`${APP_NAMESPACE}/`)) return null;

  const flat = canonicalStorageUri(resolveSelf(arg, appId));
  if (flat === null) return { kind: 'invalid' };
  if (!namesSharedStorage(flat)) return null;

  const own = `${SHARED_ROOT}/apps/${appId}`;
  if (flat === own) return { kind: 'own', path: '' };
  if (flat.startsWith(`${own}/`)) return { kind: 'own', path: flat.slice(own.length + 1) };
  return { kind: 'foreign', uri: flat };
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
 * The app's declared entries that name part of the shared tree.
 *
 * Presentation only, and back to being only that. The prompt renders it — filtered on the
 * manifest's own spelling (`yaar://storage/...`, minus the `apps/{id}/` subtree, which is
 * a different tree wearing the flat spelling) so an author reads back the line they wrote,
 * and the agent is told how far past the commons its app actually reaches.
 *
 * It admits nothing. {@link authorizeSharedStorage} does that, from `permissionsAllow`,
 * and an empty list now means "the commons and no further" rather than "no door at all" —
 * so nothing here decides whether a call is offered, only how it is described.
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
