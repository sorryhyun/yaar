// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Which app this bundle is, as the app itself declared it.
 *
 * `defineApp({ id })` records it here before it registers, so a helper that needs the
 * app's own name can ask synchronously rather than take it as an argument at every call
 * site. `sharedStorage` is the reason this exists: the commons is one flat tree with a
 * directory per producing app, and an app that has to be told its own directory name
 * ends up spelling it out in a `const SHARED_DIR = 'shared/anima'`, which is what three
 * apps were doing.
 *
 * ## Why this is not `apps/self`
 *
 * The server owns the `self` mapping — `yaar://apps/self/storage/…` is expanded against
 * the *principal*, and no iframe-side copy of that mapping is allowed, because a second
 * copy is free to drift and is simply wrong under a devtools preview (where the
 * principal is `preview--{id}`). That rule holds because in `apps/`, the app id **is**
 * the authorization boundary: which tree you reach is decided by who you are.
 *
 * In the commons it is not. `yaar://storage/shared/` is granted to every app for being
 * an app (`permissionsAllow`), so `shared/anima/` and `shared/lab/` are equally reachable
 * from either app and the directory name is a *naming convention*, not a gate. Deriving
 * it from the app's own manifest is therefore the app's own business, and it gives the
 * better answer under a preview besides: a previewed app publishes to `shared/anima/`,
 * where its released build publishes, instead of stranding artifacts in
 * `shared/preview--anima/`.
 *
 * Nothing here grants anything. Every call still goes through the same gate with the
 * same principal; this only decides what to *name*.
 */

let appId = '';

/** Called by `defineApp` before registration. Ignores an empty or non-string id. */
export function setAppId(id) {
  if (typeof id === 'string' && id) appId = id;
}

/** The registered app id, or `''` before `defineApp` has run. */
export function getAppId() {
  return appId;
}

/**
 * The registered app id, or a thrown explanation naming `op`.
 *
 * Reached when a helper that needs the app's own name is called before `defineApp` — at
 * module scope, or from an app that never registers. The failure is otherwise a path
 * with an empty segment (`shared//x.png`), which the server accepts and writes to the
 * wrong place.
 */
export function requireAppId(op) {
  if (!appId) {
    throw new Error(
      '[yaar] ' +
        op +
        ': this app has no id yet. `sharedStorage` names a directory in the commons after ' +
        'the app that owns it, so it works only after `defineApp({ id })` has run. Call it ' +
        'from a command, an event handler or the view — not at module scope.',
    );
  }
  return appId;
}
