// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The commons, scoped to this app's directory in it.
 *
 * Two storage trees are reachable without declaring any permission. `appStorage` is the
 * first — `yaar://apps/self/storage/…`, private to this app, readable by nobody else.
 * This is the second: `yaar://storage/shared/{appId}/…`, the tree apps publish artifacts
 * to for each other, granted to every app for being an app.
 *
 * `storage` (the flat, root-relative API) could always reach it. What it could not do is
 * say *which* directory is yours, so three apps wrote that down by hand — anima's
 * `const SHARED_DIR = 'shared/anima'`, lab's `sharedPath()`, slides-lite's
 * `SHARED_PREFIX` — each with its own name sanitization and its own idea of what happens
 * to a path that already starts with `shared/`. This is that constant, once, derived from
 * the app's own id (see `app-identity.ts` for why deriving it here is legitimate where
 * `apps/self` may not be).
 *
 * ## Which of the three storage APIs to reach for
 *
 * | | tree | who else can read it |
 * |---|---|---|
 * | `appStorage` | `apps/self/…` | nobody |
 * | `sharedStorage` | `shared/{appId}/…` | every app, and agents |
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
 * accepted as-is rather than nested a second time, because that is the form a listing
 * hands back and round-tripping it is the obvious thing to try.
 */

import { y } from './verbs.js';
import { requireAppId } from './app-identity.js';

/** Fold any spelling of a reference onto a root-relative path. Null if it is not storage. */
function refPath(ref) {
  return y.storage.path(ref);
}

/**
 * Resolve a caller-supplied name to a root-relative path inside this app's commons
 * directory.
 *
 * A name is normally relative (`final.png`), but a caller round-tripping something a
 * listing returned holds the full path (`shared/anima/final.png`) or a URI, and nesting
 * that into `shared/anima/shared/anima/final.png` is a silent write to the wrong place.
 * So an argument that already names *this app's own* commons directory is taken
 * literally. One that names a **different** app's directory is refused: it is either a
 * mistake or an attempt to publish under someone else's name, and `storage` is the API
 * for deliberately writing elsewhere.
 */
function resolve(name, op) {
  const dir = 'shared/' + requireAppId(op);

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

  if (folded === dir || folded.startsWith(dir + '/')) return folded;

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
        '/". Use `storage` for the rest of the tree.',
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
  /** This app's directory in the commons, as a root-relative path: `shared/{appId}`. */
  get dir() {
    return 'shared/' + requireAppId('dir');
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
    await y.storage.save(resolve(name, 'save'), data);
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
    return Array.isArray(result) ? result : [];
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

    const dir = 'shared/' + requireAppId(op);
    const path = resolve(name, op);
    await y.invoke('yaar://storage/' + path, { action: 'copy', from: source });
    return { path, uri: 'yaar://storage/' + path, name: path.slice(dir.length + 1) };
  },
};
