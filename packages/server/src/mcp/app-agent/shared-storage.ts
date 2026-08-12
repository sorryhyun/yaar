/**
 * The app agent's storage door — both trees, and who is exposed to it at all.
 *
 * Two questions live here, and they are not the same question:
 *
 *   - **Exposure** ({@link declaresSharedStorage}) — does this app's agent hold the
 *     `storage:*` built-ins and the relative `storage/...` spelling *at all*? An app
 *     whose `app.json` declares nothing under `yaar://storage/` holds neither, in the
 *     prompt, in the tool descriptions, or at execution.
 *   - **Authorization** ({@link authorizeSharedStorage}) — given that it holds the door,
 *     may it perform *this verb* on *this path*? That is `permissionsAllow`, unchanged.
 *
 * A declaration is not a per-verb grant: `{ uri: "yaar://storage/reports/", verbs:
 * ["read","list"] }` opens the door and still refuses `storage:write`. Collapsing the
 * two would make a narrow declaration mean a broad one.
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
 * This module names the target, decides exposure, and reports either refusal in the app
 * agent's terms; it never re-implements the match.
 *
 * The **iframe** side, entirely. `SELF_GRANTS` (`http/iframe-tokens.ts`), the commons in
 * `permissionsAllow`, and every `POST /api/verb` path are untouched by the exposure gate:
 * an iframe is app-authored code and an agent is a model, so an app that reaches its own
 * storage from `@bundled/yaar` while its agent may not is the intended asymmetry, not an
 * inconsistency to iron out.
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
 * The app's declared entries that name part of the shared tree.
 *
 * Two readers, and they ask different things of it. The prompt renders it — it filters
 * on the manifest's own spelling (`yaar://storage/...`, minus the `apps/{id}/` subtree,
 * which is a different tree wearing the flat spelling) so an author reads back the line
 * they wrote. {@link declaresSharedStorage} asks only whether it is *empty*.
 *
 * It used to say "presentation only … never consulted to admit anything". That stopped
 * being true when exposure became a decision: emptiness is now a gate. The entries
 * themselves still admit nothing — {@link authorizeSharedStorage} does that, from
 * `permissionsAllow` — so what this list decides is whether the door is *offered*, never
 * what passes through it.
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

/**
 * How long a resolved declaration is trusted before the manifest is read again.
 *
 * {@link getAppMeta} is uncached — one `Bun.file().text()` + `JSON.parse` per call — and
 * the modern MCP era builds a server per *request*, so an ungated predicate would put a
 * disk read on every `app`-namespace call. Short enough that an author editing app.json
 * sees the door open within a turn, long enough that a burst of tool calls reads once.
 */
const DECLARATION_TTL_MS = 5_000;
const declarationCache = new Map<string, { value: boolean; at: number }>();

/**
 * Is this app's agent exposed to the storage door at all?
 *
 * True iff the manifest declares at least one entry under `yaar://storage/` (excluding
 * the `yaar://storage/apps/` subtree). The aggressive reading is deliberate and applies
 * to the app's *own* tree as well: a capability the author never declared is not one the
 * agent should hold, even confined to the author's own directory. An undeclared app
 * reaches storage the way the design always intended — its iframe uses `@bundled/yaar`
 * inside a command declared in `protocol.json`, and the agent calls that command by name.
 *
 * The commons is deliberately *not* a declaration. `permissionsAllow` grants
 * `yaar://storage/shared/` to every app for being an app, so counting it would make the
 * predicate true for everyone and gate nothing.
 */
export async function declaresSharedStorage(appId: string): Promise<boolean> {
  const hit = declarationCache.get(appId);
  if (hit && Date.now() - hit.at < DECLARATION_TTL_MS) return hit.value;
  const value = (await sharedStorageGrants(appId)).length > 0;
  declarationCache.set(appId, { value, at: Date.now() });
  return value;
}

/** Drop the memoized declarations. Tests only — a fixture manifest changes within the TTL. */
export function resetStorageDeclarationCache(): void {
  declarationCache.clear();
}

/**
 * The refusal for an app agent that reached for a door its app never declared.
 *
 * Worded for the reader, which is the one difference from `direct_message`'s refusal:
 * that one tells the model to add `"messaging": "all"` to app.json, which is right for a
 * *monitor* agent. An app agent cannot edit its own manifest, so the actionable half is
 * its app's own commands — `describe` already lists them — and the manifest line is an
 * author-facing note, not an instruction.
 *
 * The commons is named because it is the one storage spelling that still answers: it is
 * granted for being an app, so a read of `yaar://storage/shared/...` goes through
 * whatever the manifest says. Naming it here rather than in the prompt keeps the
 * undeclared agent's prompt free of a storage door it mostly does not have, while still
 * making the part that works discoverable at the moment it is wanted.
 */
export function storageNotDeclared(appId: string, attempted: string): string {
  return (
    `not available: ${attempted} — "${appId}" declares no storage permission, so this agent ` +
    `holds no built-in storage commands, not even for its own tree. Use this app's own ` +
    `commands instead: \`describe()\` lists every command it declares, and an app that ` +
    `persists anything exposes one — its iframe holds the storage SDK, your tools do not. ` +
    `Reading \`yaar://storage/shared/{path}\` with \`query\` still works; that tree is the ` +
    `commons and needs no declaration. ` +
    `(Author note: adding an entry under "${SHARED_ROOT}/" to "permissions" in ${appId}'s ` +
    `app.json restores the built-ins — an agent cannot do this for itself.)`
  );
}
