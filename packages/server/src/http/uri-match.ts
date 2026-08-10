/**
 * Matching a `yaar://` URI against a permission list — and the two normalizations that
 * have to happen first for the match to mean anything.
 *
 * Pulled out of `access.ts` so it has no imports of its own beyond a type: it is the one
 * definition of "does this entry cover this verb on this URI", and three callers need it
 * from the far side of a module cycle. `access.ts` asks it at the gate; `iframe-tokens.ts`
 * asks it when minting a devtools preview's identity, to cap what a project file may
 * declare against what devtools itself holds; `features/apps/discovery.ts` asks
 * `coversForeignAppStorage` when reading a manifest, to narrow an installed app's storage
 * grants to its own subtree. All three import `access.ts` for types only — `access.ts`
 * imports `iframe-tokens.js`, and `iframe-tokens.ts` imports `discovery.js`, so a value
 * import back into the gate from any of them closes a real cycle whose symptom is an
 * undefined binding at module init, not a build error.
 *
 * A second copy of any of this is exactly the drift that would let a prefix mean one
 * thing at mint time and another at the door. `access.ts` re-exports every name, so its
 * callers are unchanged and it stays the place you read to learn the rule.
 */

import type { Verb } from '../handlers/uri-registry.js';
import type { PermissionEntry } from './access.js';

/** Every verb a string permission entry implies. */
export const ALL_VERBS: readonly Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];

/**
 * A trailing slash is what makes a pattern a *prefix*; without one it names exactly
 * one resource. `uri + '/' === pattern` lets `yaar://storage` match the entry
 * `yaar://storage/` — the directory itself, named without its slash.
 */
export function uriMatches(uri: string, pattern: string): boolean {
  return (
    uri === pattern || (pattern.endsWith('/') && (uri.startsWith(pattern) || uri + '/' === pattern))
  );
}

export function isUriAllowed(uri: string, verb: Verb, entries: PermissionEntry[]): boolean {
  return entries.some((entry) => {
    if (typeof entry === 'string') {
      return uriMatches(uri, entry); // string entry → all verbs allowed
    }
    return uriMatches(uri, entry.uri) && (!entry.verbs || entry.verbs.includes(verb));
  });
}

/** The verbs an entry actually confers, whichever of the two spellings it uses. */
export function entryVerbs(entry: PermissionEntry): readonly Verb[] {
  return typeof entry === 'string' ? ALL_VERBS : (entry.verbs ?? ALL_VERBS);
}

/** The URI an entry names, whichever of the two spellings it uses. */
export function entryUri(entry: PermissionEntry): string {
  return typeof entry === 'string' ? entry : entry.uri;
}

// ── `self`, and the two spellings of app storage ────────────────────────────

/**
 * Does this URI still name `self` — i.e. is it written in the app's own dialect
 * rather than in real ids?
 *
 * The counterpart to {@link resolveSelf}, which leaves such a URI untouched when it
 * has no appId to expand against. Callers that must not store or match an
 * unresolved URI (the subscription registry keys by literal string) test the
 * *result* of `resolveSelf` with this rather than re-deriving the spelling.
 *
 * Both dialects count, for the reason given on `resolveSelf`.
 */
export function namesSelf(uri: string): boolean {
  return (
    uri === 'yaar://apps/self' ||
    uri.startsWith('yaar://apps/self/') ||
    uri === `${APP_STORAGE_ROOT}self` ||
    uri.startsWith(`${APP_STORAGE_ROOT}self/`)
  );
}

/**
 * Rewrite `yaar://apps/self/…` — and its flat twin `yaar://storage/apps/self/…` — to the
 * calling app's real id.
 *
 * Applied to *both* sides of the match — the URI being requested and the app's
 * declared permissions — because the two are not written in the same dialect. An
 * app.json says `yaar://apps/self/storage/`; a storage URI derived from an HTTP path
 * says `yaar://apps/notes/storage/todo.json`. Matching those literally denies an app
 * its own storage. Canonicalizing both means either spelling works and they agree.
 *
 * The flat dialect is here rather than in {@link canonicalStorageUri} because expansion
 * has to happen *first*: `apps/self` names no subtree of the storage root until `self` is
 * a real id, so canonicalization would otherwise mint a literal `self` directory. It used
 * to be reachable the other way round — canonicalization ran first and rewrote the flat
 * spelling into the namespaced one, where this function found it — which is exactly the
 * kind of load-bearing accident that stops working when the order changes.
 *
 * Exported because the permission gate is not the only place `self` has to be
 * expanded: `POST /api/verb` resolves it before dispatching, and
 * `/api/verb/subscribe` before *storing* the URI (a subscription keyed by the
 * `self` spelling would never match the real-id URI a producer notifies with). All
 * three used to spell the rewrite out by hand, so a change to the spelling — or a
 * future `windows/self` — was a three-site edit that would fail silently in the two
 * sites that were missed. Returns the URI unchanged when there is no appId to
 * expand against; the caller decides whether that is fatal ({@link namesSelf}).
 *
 * The path-flavored variant in {@link storageUriFor} is deliberately *not* folded in:
 * it expands `apps/self` inside an HTTP **path** (`apps/self/x.json`), not a URI, and
 * round-tripping it through the URI form to share these five lines would be more
 * indirection than the duplication costs. The two must agree on the literal `self`
 * segment and nothing else.
 */
export function resolveSelf(uri: string, appId?: string): string {
  if (!appId) return uri;
  if (uri === `${APP_STORAGE_ROOT}self`) return `${APP_STORAGE_ROOT}${appId}`;
  if (uri.startsWith(`${APP_STORAGE_ROOT}self/`)) {
    return `${APP_STORAGE_ROOT}${appId}/${uri.slice(`${APP_STORAGE_ROOT}self/`.length)}`;
  }
  if (uri === 'yaar://apps/self') return `yaar://apps/${appId}`;
  if (uri.startsWith('yaar://apps/self/')) {
    return uri.replace('yaar://apps/self/', `yaar://apps/${appId}/`);
  }
  return uri;
}

/** `yaar://apps/{id}/storage`, with everything under it. */
const APP_STORAGE_URI = /^yaar:\/\/apps\/([^/]+)\/storage(?:\/(.*))?$/;

/** The flat tree every app's private storage actually lives under. */
const APP_STORAGE_ROOT = 'yaar://storage/apps/';

/**
 * The commons: the one storage prefix every app holds without declaring it.
 *
 * Its counterpart is {@link APP_STORAGE_ROOT} — that tree is one app each, this one is
 * all of them. Apps exchange files by publishing here under their own name
 * (`shared/{producer}/`), which is a convention for tidiness, not a boundary: the grant
 * is the whole prefix, so an app can read what another published without either of them
 * having asked the user for anything.
 *
 * Granted at token mint time (`SHARED_GRANT` in iframe-tokens.ts) and therefore
 * *subtracted* from what an install dialog asks about (`capabilities.ts`) — a manifest
 * that declares it is asking for something it already has, and a dialog row for a
 * capability the user cannot decline teaches them to click through.
 */
export const SHARED_STORAGE_ROOT = 'yaar://storage/shared/';

/**
 * Is this entry asking for nothing but the commons, which every app already holds?
 *
 * The prefix and anything under it both answer true — an app declaring
 * `yaar://storage/shared/anima/` is naming a corner of a tree it already reaches in
 * full. The storage root itself does not: `yaar://storage/` covers `apps/` too, which
 * is exactly the grant that has to keep being asked about.
 */
export function coversSharedTreeOnly(entry: PermissionEntry): boolean {
  const uri = entryUri(entry);
  return uri === 'yaar://storage/shared' || uri.startsWith(SHARED_STORAGE_ROOT);
}

/** A path segment that climbs out of the subtree it was resolved against. */
function traverses(path: string): boolean {
  return path.split('/').includes('..');
}

/**
 * Rewrite an app's storage URI to the flat tree it actually names.
 *
 * `yaar://apps/notes/todo.json`'s two spellings — `yaar://apps/notes/storage/todo.json`
 * and `yaar://storage/apps/notes/todo.json` — are the same file, and the *second* is the
 * real one: on disk an app's storage is a plain subtree of the storage root
 * (`STORAGE_DIR/apps/{id}/`), so the namespaced form is an alias for it and not the other
 * way round. This canonicalizes toward the thing on disk.
 *
 * It used to canonicalize the other way, to keep a declared `yaar://storage/` from
 * silently covering every other app's storage. That worked, at the cost of making the
 * prefix mean something no reader could predict: it matched `yaar://storage/apps` but
 * nothing beneath it, so the file manager could list every app's storage directory and
 * open none of them, and the install dialog's "Full access to YAAR storage" described a
 * grant the gate then declined to hand out. It also only ever stopped the *broad* prefix
 * — `yaar://storage/apps/vault/`, named outright, went straight through.
 *
 * So the containment moved to where it can state the whole rule: `coversForeignAppStorage`
 * decides who may *declare* a grant reaching outside its own subtree, and `discovery.ts`
 * applies it to every non-bundled app. What a prefix means is no longer where that fight
 * happens.
 *
 * Returns the URI unchanged when it names no storage, and `null` for a traversing path —
 * which names no resource and must not be matched against anything. Both spellings are
 * checked now; the namespaced one used to pass through untouched.
 */
export function canonicalStorageUri(uri: string): string | null {
  if (uri === 'yaar://storage' || uri.startsWith('yaar://storage/')) {
    return traverses(uri.slice('yaar://storage'.length)) ? null : uri;
  }

  const match = APP_STORAGE_URI.exec(uri);
  if (!match) return uri;

  const [, appId, rest] = match;
  if (appId === '..' || (rest !== undefined && traverses(rest))) return null;

  // `self` names no subtree until `resolveSelf` has expanded it — which the gate does
  // first, so reaching here with it unexpanded means there was no appId to expand
  // against. Rewriting anyway would invent a literal `apps/self/` directory.
  if (appId === 'self') return uri;

  // `rest` distinguishes the three endings that matter to `uriMatches`: absent is the
  // directory named without its slash, empty is the prefix, and anything else carries
  // its own trailing slash through.
  return `${APP_STORAGE_ROOT}${appId}${rest === undefined ? '' : `/${rest}`}`;
}

/** One app's whole namespace — `yaar://apps/{id}/`, storage and db and agents alike. */
const APP_NAMESPACE_PREFIX = /^yaar:\/\/apps\/([^/]+)\/$/;

/**
 * Every URI a *granted* entry covers, once app storage is read in flat coordinates.
 *
 * Targets canonicalize; grants have to expand, and the difference is what a prefix does.
 * `yaar://apps/notes/` covers `yaar://apps/notes/storage/x` in the dialect it is written
 * in, but that target arrives at the match canonicalized to `yaar://storage/apps/notes/x`
 * — outside the prefix entirely. So a grant over one app's whole namespace carries the
 * flat spelling of its storage alongside the original, which still covers the `db/` and
 * `agents/` sub-paths that have no flat twin.
 *
 * The bare registry prefix `yaar://apps/` deliberately gets no such alias. It names one
 * app id nowhere, the install dialog describes it as "see and manage installed apps", and
 * before the canonicalization was flipped it silently prefix-matched every app's private
 * storage — the one widening this whole change was supposed to remove, not relocate.
 */
function grantAliases(uri: string): string[] {
  const canonical = canonicalStorageUri(uri);
  if (canonical === null) return [];
  if (canonical !== uri) return [canonical];

  const ownNamespace = APP_NAMESPACE_PREFIX.exec(uri);
  return ownNamespace ? [uri, `${APP_STORAGE_ROOT}${ownNamespace[1]}/`] : [uri];
}

/** Expand one declared entry into the entries the match should actually see. */
export function grantEntries(entry: PermissionEntry, appId?: string): PermissionEntry[] {
  const uris = grantAliases(resolveSelf(entryUri(entry), appId));
  return uris.map((uri) => (typeof entry === 'string' ? uri : { ...entry, uri }));
}

/**
 * Does this entry grant storage belonging to an app other than `appId`?
 *
 * The gate that replaced the old canonicalization, and it covers the class rather than
 * one spelling of it: the storage root, the `apps/` namespace, and another app named
 * outright all answer true, in either dialect — including `yaar://apps/vault/`, which
 * reaches vault's storage through the alias above and would otherwise read as a
 * non-storage grant. `discovery.ts` drops such an entry from every non-bundled app's
 * manifest, so "full access to YAAR storage" is a thing only an app shipped with the repo
 * can ask for; a marketplace app that declares it is narrowed to exactly what it could
 * reach before.
 *
 * Its own subtree is never foreign, however it is spelled, and a bare `yaar://storage`
 * (no trailing slash — the root listing, not a prefix over it) reaches no app's files.
 */
export function coversForeignAppStorage(entry: PermissionEntry, appId: string): boolean {
  const aliases = grantAliases(resolveSelf(entryUri(entry), appId));
  if (aliases.length === 0) return true; // traversing — never a grant worth keeping
  return aliases.some((alias) => aliasCoversForeignAppStorage(alias, appId));
}

/**
 * Does this URI name app storage that does not belong to `appId`?
 *
 * The target-side counterpart of {@link coversForeignAppStorage}, which asks the same
 * question of a *grant*. Takes an already-canonical URI.
 */
export function namesForeignAppStorage(canonical: string, appId?: string): boolean {
  if (!canonical.startsWith(APP_STORAGE_ROOT)) return false;
  if (!appId) return true;
  const own = `${APP_STORAGE_ROOT}${appId}`;
  return canonical !== own && !canonical.startsWith(`${own}/`);
}

/** Is this entry capped to the shared tree — see `PermissionEntry.sharedOnly`? */
export function isSharedOnly(entry: PermissionEntry): boolean {
  return typeof entry !== 'string' && entry.sharedOnly === true;
}

/**
 * Cap every grant that reaches into another app's storage, rather than dropping it.
 *
 * The difference matters: `yaar://storage/` is one entry doing two jobs, and only one of
 * them is contentious. Discarding it would take the shared tree — `shared/`, whatever the
 * user or the monitor left at the root — away from apps that have always had it, to close
 * a reach into `apps/` they never did. So the entry survives, marked, and
 * `permissionsAllow` declines it for exactly the URIs it should never have covered.
 *
 * An entry that names *only* foreign app storage (`yaar://storage/apps/vault/`) keeps
 * nothing once capped, which is the right answer for it too — the mark is a ceiling, so a
 * grant with nothing under the ceiling grants nothing.
 *
 * Applied by `discovery.ts` to every non-bundled manifest and by `iframe-tokens.ts` to
 * every devtools preview.
 */
export function capForeignAppStorage(
  permissions: PermissionEntry[],
  appId: string,
): { capped: PermissionEntry[]; changed: number } {
  let changed = 0;
  const capped = permissions.map((entry) => {
    if (isSharedOnly(entry) || !coversForeignAppStorage(entry, appId)) return entry;
    changed++;
    const verbs = typeof entry === 'string' ? undefined : entry.verbs;
    return { uri: entryUri(entry), ...(verbs && { verbs }), sharedOnly: true as const };
  });
  return { capped, changed };
}

function aliasCoversForeignAppStorage(canonical: string, appId: string): boolean {
  if (!canonical.startsWith('yaar://storage')) return false;

  const own = `${APP_STORAGE_ROOT}${appId}`;
  if (canonical === own || canonical.startsWith(`${own}/`)) return false;

  // Named outright, or one of the prefixes sitting above the whole namespace.
  if (canonical.startsWith(APP_STORAGE_ROOT)) return true;
  return canonical.endsWith('/') && APP_STORAGE_ROOT.startsWith(canonical);
}
