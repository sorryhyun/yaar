// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Which app this bundle *says* it is — the id passed to `defineApp`, recorded before
 * registration so a helper can ask synchronously rather than take it as an argument.
 *
 * ## This is not the app's identity
 *
 * Identity is the iframe token's, and only the server can read it. This is a claim the
 * bundle makes about itself, and the two differ exactly where it matters most: under a
 * devtools preview the principal is `preview--{projectId}` while this still says
 * `image-edit`.
 *
 * `sharedStorage` used to build the commons directory name out of this value, on the
 * argument that `shared/{producer}/` is a naming convention rather than a boundary (it
 * is — every app reaches the whole commons) and that a preview publishing to
 * `shared/image-edit/` is the *useful* answer, since that is where the released build
 * publishes. What that missed is that "useful" and "throwaway" were being decided per
 * tree: `apps/self` sandboxed a preview and the commons did not, so unshipped code wrote
 * into the live app's directory beside real user files, with nothing marking it as a
 * preview's work. The server now expands `shared/self/…` the same way it expands
 * `apps/self/…`, and one principal decides both.
 *
 * ## What it is still for
 *
 * Recognising the app's *own* name in a path a caller passed back in
 * (`sharedStorage`'s `ownSuffix`), so a round-tripped `shared/image-edit/x.png` is
 * re-based onto the pronoun instead of being nested or refused. Naming a tree to write
 * to is not on the list — reach for `self` and let the gate resolve it.
 */

let appId = '';

/** Called by `defineApp` before registration. Ignores an empty or non-string id. */
export function setAppId(id) {
  if (typeof id === 'string' && id) appId = id;
}

/**
 * The registered app id, or `''` before `defineApp` has run.
 *
 * An empty answer is ordinary now and every caller must tolerate it. `requireAppId` —
 * which threw "this app has no id yet" at module scope — is gone with the need for it:
 * `sharedStorage` names `shared/self`, so nothing here has to be known before a path can
 * be built, and calling it at module scope is no longer a footgun.
 */
export function getAppId() {
  return appId;
}
