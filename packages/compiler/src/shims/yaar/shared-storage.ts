// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The commons, scoped to this app's directory in it.
 *
 * Two storage trees are reachable without declaring any permission. `appStorage` is the
 * first — `yaar://apps/self/storage/…`, scoped to this app, reachable by no other installed
 * app (it is still a plain subtree of storage, `yaar://storage/apps/{appId}/`, which the user
 * and agents see).
 * This is the second: `yaar://storage/shared/{appId}/…`, the tree apps publish artifacts
 * to for each other, granted to every app for being an app.
 *
 * `storage` (the flat, root-relative API) could always reach it. What it could not do is
 * say *which* directory is yours, so three apps wrote that down by hand — anima's
 * `const SHARED_DIR = 'shared/anima'`, lab's `sharedPath()`, slides-lite's
 * `SHARED_PREFIX` — each with its own name sanitization and its own idea of what happens
 * to a path that already starts with `shared/`. This is that constant, once.
 *
 * ## Who decides which directory is yours
 *
 * **The server does**, from the iframe token, exactly as it does for `apps/self`. Every
 * path here goes out spelled `shared/self/…` and `resolveSelf` (server `http/uri-match.ts`)
 * expands it against the calling principal.
 *
 * It used to be built here instead, from the id the app passed to `defineApp` — the same
 * value in the bundle whoever is running it. Under a devtools preview that is the wrong
 * answer and nothing catches it: the principal is `preview--{projectId}` while the
 * declared id is the shipped app's, so a preview published into the **live** app's commons
 * directory, on top of whatever the user already had there, indistinguishably from the
 * deployed app. `appStorage` never had that failure because it never named itself.
 *
 * ## Which of the three storage APIs to reach for
 *
 * | | tree | who else can read it |
 * |---|---|---|
 * | `appStorage` | `apps/self/…` | nobody |
 * | `sharedStorage` | `shared/self/…` → `shared/{principal}/…` | every app, and agents |
 * | `storage` | the whole root | — it is the raw, unscoped API |
 *
 * Reach for `storage` when you hold a path *someone else* produced (an image from
 * `shared/anima/`, a file under `mounts/`); reach for `sharedStorage` when the app is
 * producing something for others to find. `storage.path()` folds any spelling of a
 * reference onto a root-relative path, and every method here accepts the same spellings.
 *
 * ## Names are subpaths, not filenames
 *
 * `sharedStorage.save('renders/final.png', …)` writes `shared/{appId}/renders/final.png`.
 * A leading slash is ignored and `..` is refused; a name that already spells out this
 * app's own commons directory (`shared/anima/x.png`, or any URI dialect of it) is
 * accepted rather than nested a second time, because that is the form a listing hands
 * back and round-tripping it is the obvious thing to try.
 *
 * ## What the returned paths say
 *
 * `dir`, `path()`, `uri()` and `publish()` answer with the app's **real** directory as
 * soon as the server has named it — every `save`, `list` and `publish` reports the
 * expanded path back, and {@link learnDir} keeps it. Before that they answer
 * `shared/self/…`, which every YAAR door resolves the same way. The distinction matters
 * in one place: a *monitor* agent has no app identity, so a `self` path handed to one in
 * a message names nothing. Publish or list first — which is the order an app already
 * works in, since it advertises files it has written.
 */

import { y } from './verbs.js';
import { getAppId } from './app-identity.js';

/** Fold any spelling of a reference onto a root-relative path. Null if it is not storage. */
function refPath(ref) {
  return y.storage.path(ref);
}

/** The wire spelling: the server expands `self` against the calling principal. */
const SELF_DIR = 'shared/self';

/**
 * The directory the server reported back — `shared/{principal id}` — or `''` until one
 * has been. Only ever set from a path the *server* produced, never from the app's own
 * declared id: that is the guess this module exists to stop making.
 */
let knownDir = '';

/** Record the real commons directory out of a path the server returned. */
function learnDir(path) {
  if (typeof path !== 'string') return;
  const m = /^shared\/([^/]+)(?:\/|$)/.exec(path);
  if (m && m[1] !== 'self') knownDir = 'shared/' + m[1];
}

/** This app's commons directory, as concretely as it is currently known. */
function dirNow() {
  return knownDir || SELF_DIR;
}

/**
 * If `folded` already names this app's own commons directory, the part after it —
 * `''` for the directory itself. Null when it names somewhere else.
 *
 * Three spellings count. `shared/self/…` is what this module emits. The learned
 * directory is what a listing hands back. The **declared** id counts too, because an app
 * that stored a path before this changed (or read one from a deployed sibling) spells
 * that — but it is folded back onto the pronoun rather than taken literally, so under a
 * preview it still lands in the preview's directory instead of the shipped app's.
 */
function ownSuffix(folded) {
  const dirs = [SELF_DIR];
  if (knownDir) dirs.push(knownDir);
  const declared = getAppId();
  if (declared) dirs.push('shared/' + declared);

  for (let i = 0; i < dirs.length; i++) {
    if (folded === dirs[i]) return '';
    if (folded.indexOf(dirs[i] + '/') === 0) return folded.slice(dirs[i].length + 1);
  }
  return null;
}

/**
 * Resolve a caller-supplied name to a root-relative path inside this app's commons
 * directory.
 *
 * A name is normally relative (`final.png`), but a caller round-tripping something a
 * listing returned holds the full path (`shared/anima/final.png`) or a URI, and nesting
 * that into `shared/anima/shared/anima/final.png` is a silent write to the wrong place.
 * So an argument that already names *this app's own* commons directory ({@link ownSuffix})
 * is re-based onto it rather than nested. One that names a **different** app's directory
 * is refused: it is either a mistake or an attempt to publish under someone else's name,
 * and `storage` is the API for deliberately writing elsewhere.
 */
function resolve(name, op) {
  const dir = dirNow();

  if (name == null || name === '') return dir;
  if (typeof name !== 'string') {
    throw new Error('[yaar] sharedStorage.' + op + ': name must be a string.');
  }

  const folded = refPath(name);
  if (folded === null) {
    throw new Error(
      '[yaar] sharedStorage.' +
        op +
        ': "' +
        name +
        '" is not a storage path. Pass a name inside this app\'s shared directory, like ' +
        '"final.png" or "renders/final.png".',
    );
  }

  const own = ownSuffix(folded);
  if (own !== null) return own === '' ? dir : dir + '/' + own;

  // A name that folds onto one of the storage root's own namespaces is not a name — it
  // is a path the caller meant to hand to `storage`. Nesting it (`shared/anima/apps/…`)
  // writes real bytes to a place nobody will look for them, so refuse instead. `shared/`
  // is called out separately because it is the near miss with its own answer.
  const root = folded.split('/')[0];
  if (root === 'shared') {
    throw new Error(
      '[yaar] sharedStorage.' +
        op +
        ': "' +
        name +
        '" names another app\'s directory in the commons. sharedStorage only reaches "' +
        dir +
        '/"' +
        (dir === SELF_DIR ? ' (the server expands "self" to this app)' : '') +
        '. Use `storage` for the rest of the tree.',
    );
  }
  if (root === 'apps' || root === 'mounts' || root === 'temp' || root === 'files') {
    throw new Error(
      '[yaar] sharedStorage.' +
        op +
        ': "' +
        name +
        '" is a path in the "' +
        root +
        '/" tree, not a name in this app\'s shared directory. Pass a name like "final.png", ' +
        'or use `storage` (or `appStorage` for "apps/") to reach that path directly.',
    );
  }

  return dir + '/' + folded.replace(/^\/+/, '');
}

/**
 * `from` for a server-side copy, as a URI the server will resolve.
 *
 * A `yaar://` reference is passed through **unchanged**, deliberately: `resolveSelf`
 * expands `self` only in the `yaar://apps/self/…` dialect, so folding
 * `yaar://apps/self/storage/x.png` down to its root-relative path and rebuilding it as
 * `yaar://storage/apps/self/x.png` would produce a URI naming a literal directory called
 * `self`. Everything else (a bare path, an `/api/storage/` URL) has no `self` to lose.
 */
function sourceUri(from, op) {
  if (typeof from === 'string' && from.indexOf('yaar://') === 0) return from;

  const path = refPath(from);
  if (path === null) {
    throw new Error(
      '[yaar] sharedStorage.' +
        op +
        ': "' +
        from +
        '" is not a stored file. Publish copies bytes that are already in storage — save ' +
        'them with `appStorage` or `storage` first.',
    );
  }
  return 'yaar://storage/' + path;
}

export const sharedStorage = {
  /**
   * This app's directory in the commons, as a root-relative path — `shared/{appId}` once
   * the server has named it, `shared/self` until then. Both name the same directory to
   * every YAAR door; see the header for the one caller that cannot resolve the pronoun.
   */
  get dir() {
    return dirNow();
  },

  /** A name inside this app's commons directory, as a root-relative path. */
  path(name?) {
    return resolve(name, 'path');
  },

  /** A name inside this app's commons directory, as a `yaar://storage/…` URI. */
  uri(name?) {
    return 'yaar://storage/' + resolve(name, 'uri');
  },

  /**
   * A URL an `<img src>`, `<video>` or CSS `url()` can load — carries the iframe token,
   * which a subresource fetch has no way to attach as a header.
   */
  url(name) {
    return y.storage.url(resolve(name, 'url'));
  },

  /** Write a file into this app's commons directory. */
  async save(name, data) {
    // The write reports back the path it landed on, with `self` already expanded — the
    // cheapest place to learn this app's real directory, and one every app reaches.
    const result = await y.storage.save(resolve(name, 'save'), data);
    if (result) learnDir(result.path);
  },

  /**
   * Read a file back. `options.as` picks the decoding (`text`, `json`, `blob`,
   * `arraybuffer`); the default follows the response's content type.
   */
  async read(name, options?) {
    return y.storage.read(resolve(name, 'read'), options);
  },

  /** Read a file as a Blob — the form an `<img>`, a canvas or `mediabunny` wants. */
  async readBlob(name) {
    return y.storage.read(resolve(name, 'readBlob'), { as: 'blob' });
  },

  /**
   * List this app's commons directory, or a subdirectory of it. Newest writes are not
   * sorted for you — entries come back in the order the server read them.
   */
  async list(subdir?) {
    const result = await y.storage.list(resolve(subdir, 'list'));
    if (!Array.isArray(result)) return [];
    // Entries come back with `self` expanded, so a listing names this app's real
    // directory even when nothing has been written through this SDK yet.
    if (result.length > 0) learnDir(result[0].path);
    return result;
  },

  /** Delete a file from this app's commons directory. */
  async remove(name) {
    await y.storage.remove(resolve(name, 'remove'));
  },

  /**
   * Copy a file that is already in storage into this app's commons directory, and return
   * where it landed.
   *
   * The copy happens **server-side** — `from` is a reference, not bytes. Reading a file
   * out and writing it back through `save()` routes it through the iframe, and for an
   * image that an agent then asks about, through a model context: anima's 550KB PNG was
   * the case that made this a method rather than a note.
   *
   * `options.as` names the file in the commons; it defaults to `from`'s own basename.
   */
  async publish(from, options?) {
    const op = 'publish';
    const source = sourceUri(from, op);

    let name = options && options.as;
    if (!name) {
      const path = refPath(from);
      name = path ? path.split('/').pop() : '';
      if (!name) {
        throw new Error(
          '[yaar] sharedStorage.publish: could not derive a name from "' +
            from +
            '". Pass one as `{ as: "final.png" }`.',
        );
      }
    }

    const dest = resolve(name, op);
    const relative = dest.slice(dirNow().length + 1);
    await y.invoke('yaar://storage/' + dest, { action: 'copy', from: source });

    // What `publish` returns is meant to be handed *outward* — to an agent, to another
    // app — so it must not carry the `self` pronoun, which only this app's principal can
    // resolve. The copy reports its destination in prose rather than as a field, so learn
    // the directory the way `list` does instead of parsing the sentence. At most one
    // extra request per app: the file was just written, so the listing cannot be empty.
    if (!knownDir) {
      try {
        const entries = await y.storage.list(SELF_DIR);
        if (Array.isArray(entries) && entries.length > 0) learnDir(entries[0].path);
      } catch {
        /* best effort — the pronoun still names the right file to every YAAR door */
      }
    }

    const path = dirNow() + '/' + relative;
    return { path, uri: 'yaar://storage/' + path, name: relative };
  },
};
