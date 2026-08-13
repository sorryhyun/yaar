/**
 * Inline JS storage SDK for iframe apps.
 *
 * Provides window.yaar.storage with save/read/list/remove/url methods
 * that dispatch to the /api/storage REST endpoints.
 *
 * ## Every spelling of a stored file arrives here
 *
 * One file has four names, and an app holds whichever one its own layer produced:
 * `shared/anima/dragon.png` from a listing, `yaar://storage/shared/anima/dragon.png`
 * from a verb, `yaar://apps/self/storage/x.png` from an app.json permission or an
 * agent, `/api/storage/shared/anima/dragon.png` from an HTTP route. They name the
 * same bytes — the server folds the two URI dialects together at the gate
 * (`canonicalStorageUri`) and maps every REST path onto a URI (`storageUriForPath`).
 *
 * Accepting only the flat one was left to each app to notice, and eight of them wrote
 * their own resolver: four missed the namespaced dialect (an image the editor shows
 * and the export leaves blank), one hand-built a `/api/storage/` URL with no token
 * (dead the moment app-origin isolation is on), one guessed by reading the shared tree
 * and catching the failure. So `storageRefPath` is the one normalization, and every
 * method below runs its argument through it.
 *
 * It lives in this script rather than in the compiled SDK shim because it also has to
 * cover apps reaching `window.yaar.storage` directly, and because `url()` — the one
 * builder that must not be reimplemented — is already here.
 *
 * Two things it deliberately does not do. It does not expand `self`: `/api/storage`
 * resolves it against the calling app, and a second copy of that mapping in the iframe
 * would be free to drift from the first (and is simply wrong under a devtools preview,
 * where the principal is `preview--{id}`). And it does not decide what is *allowed* —
 * a path outside both trees is still sent, because an agent may have delegated one file
 * to this window, a grant no code in the iframe can see. The only refusals are `..`,
 * which names no resource, and a reference that is not storage at all.
 */
import {
  API_BOOTSTRAP,
  installGuard,
  JSON_ERROR_UNWRAP,
  TOKEN_HEADERS,
  YAAR_NAMESPACE,
} from './prelude.js';

export const IFRAME_STORAGE_SDK_SCRIPT = `
(function() {
  ${installGuard('__yaarStorageInstalled')}
  ${YAAR_NAMESPACE}
  ${API_BOOTSTRAP}
  ${TOKEN_HEADERS}
  ${JSON_ERROR_UNWRAP}

  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  // A path that climbs out of the storage root names no resource, so it must not be
  // handed on as if it did.
  function traverses(p) {
    return p.split('/').indexOf('..') !== -1;
  }

  function stripLeadingSlashes(p) {
    return p.replace(/^\\/+/, '');
  }

  // The REST form is percent-encoded segment by segment (see encodePath), so a URL
  // round-tripped back through here has to be decoded or the next url() call encodes
  // it twice. Only this form is known to be encoded; the URI dialects are not.
  function decodePath(p) {
    try {
      return p.split('/').map(decodeURIComponent).join('/');
    } catch (e) {
      return p; // a stray '%' is not an encoding — leave it alone
    }
  }

  var REST_PREFIX = /^\\/?api\\/storage(?:\\/|$)/;
  var APP_STORAGE_URI = /^yaar:\\/\\/apps\\/([^/]+)\\/storage(?:\\/|$)/;
  var STORAGE_URI = /^yaar:\\/\\/storage(?:\\/|$)/;

  /**
   * Any spelling of a stored file, reduced to a storage-root-relative path.
   * Returns null when the reference names something that is not storage — another
   * kind of yaar:// resource, an http(s) URL, a data: URL — or traverses.
   */
  function storageRefPath(ref) {
    if (typeof ref !== 'string') return null;
    var p = ref.trim();
    if (!p) return null;

    // An absolute URL only names storage through the REST route. Which origin served
    // it does not matter: under app-origin isolation API_BASE is the desktop origin
    // and the app's own is a sibling, and no host outside YAAR answers /api/storage.
    var absolute = /^https?:\\/\\/[^/]*(\\/.*)?$/.exec(p);
    if (absolute) {
      p = absolute[1] || '/';
      if (!REST_PREFIX.test(p)) return null;
    }

    var appScoped = APP_STORAGE_URI.exec(p);
    if (appScoped) {
      // 'self' is passed through, not expanded — the server owns that mapping.
      var rest = p.slice(appScoped[0].length);
      p = 'apps/' + appScoped[1] + (rest ? '/' + rest : '');
    } else if (STORAGE_URI.test(p)) {
      p = p.slice('yaar://storage'.length);
    } else if (p.indexOf('yaar://') === 0) {
      return null; // a yaar:// resource that is not storage
    } else if (REST_PREFIX.test(p)) {
      p = decodePath(p.replace(REST_PREFIX, ''));
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
      return null; // data:, blob:, file:, ... — bytes or a location, not a path
    }

    p = stripLeadingSlashes(p);
    return traverses(p) ? null : p;
  }

  function pathError(ref, op) {
    return new Error(
      'storage.' + op + ': "' + String(ref) + '" is not a storage path. Expected a path ' +
      'like "shared/x.png" or "apps/self/x.png", or a yaar://storage/, ' +
      'yaar://apps/{id}/storage/ or /api/storage/ reference to one.'
    );
  }

  /**
   * storageRefPath for the synchronous builders, which have no promise to reject on.
   * The async methods reject instead: a promise-returning method that throws
   * synchronously escapes a .catch() chain, which is where an app would look for it.
   */
  function requirePath(ref, op) {
    var p = storageRefPath(ref);
    if (p === null) throw pathError(ref, op);
    return p;
  }

  window.yaar.storage = {
    path: storageRefPath,
    save: function(path, data) {
      var p = storageRefPath(path);
      if (p === null) return Promise.reject(pathError(path, 'save'));
      var body;
      if (typeof data === 'string') {
        body = data;
      } else if (data instanceof Blob) {
        body = data;
      } else if (data instanceof ArrayBuffer) {
        body = data;
      } else if (data instanceof Uint8Array) {
        body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        body = String(data);
      }
      return fetch(API_BASE + '/api/storage/' + encodePath(p), {
        method: 'POST',
        headers: tokenHeaders(),
        body: body
      }).then(function(res) {
        if (!res.ok) return throwJsonError(res, 'Save failed');
        return res.json();
      });
    },
    read: function(path, options) {
      var p = storageRefPath(path);
      if (p === null) return Promise.reject(pathError(path, 'read'));
      var mode = (options && options.as) || 'auto';
      return fetch(API_BASE + '/api/storage/' + encodePath(p), {
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) return throwJsonError(res, 'Read failed');
        if (mode === 'blob') return res.blob();
        if (mode === 'arraybuffer') return res.arrayBuffer();
        if (mode === 'json') return res.json();
        if (mode === 'text') return res.text();
        var ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) return res.json();
        if (ct.startsWith('text/')) return res.text();
        return res.blob();
      });
    },
    list: function(dirPath) {
      // Omitted, empty or null is the storage root — the one place an absent
      // reference is an answer rather than a mistake.
      var p = dirPath ? storageRefPath(dirPath) : '';
      if (p === null) return Promise.reject(pathError(dirPath, 'list'));
      return fetch(API_BASE + '/api/storage/' + encodePath(p) + '?list=true', {
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) return throwJsonError(res, 'List failed');
        return res.json();
      });
    },
    remove: function(path) {
      var p = storageRefPath(path);
      if (p === null) return Promise.reject(pathError(path, 'remove'));
      return fetch(API_BASE + '/api/storage/' + encodePath(p), {
        method: 'DELETE',
        headers: tokenHeaders()
      }).then(function(res) {
        if (!res.ok) return throwJsonError(res, 'Delete failed');
        return res.json();
      });
    },
    url: function(path) {
      // Carry the token in the query string. This URL exists to be handed to an
      // <img src>, a <video>, a CSS url() — subresource fetches the app cannot attach
      // a header to, so tokenHeaders() is unreachable here. Without it the server sees
      // no token, resolves the caller as "host" rather than as this app, and a path
      // containing "self" cannot be resolved at all (403). The access gate already
      // accepts the __yaar_token query param for exactly this case; only this builder
      // never sent it.
      var base = API_BASE + '/api/storage/' + encodePath(requirePath(path, 'url'));
      var t = yaarToken();
      return t ? base + '?__yaar_token=' + encodeURIComponent(t) : base;
    }
  };
})();
`;
