/**
 * How the storage SDK resolves a reference to a stored file.
 *
 * One file has four names — a bare path, `yaar://storage/…`, `yaar://apps/{id}/storage/…`,
 * `/api/storage/…` — and the server folds all four onto the same bytes. Before this
 * normalization each app resolved them itself, and they disagreed: four apps dropped the
 * namespaced dialect (an image the editor showed and the export left blank), one built a
 * `/api/storage/` URL by hand with no token (dead under app-origin isolation), one guessed
 * by reading the shared tree and catching the failure.
 *
 * The script is a string of ES5 injected into an iframe, so it is exercised the way the
 * browser runs it — evaluated with `window`/`location`/`fetch` supplied — rather than
 * pattern-matched.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_STORAGE_SDK_SCRIPT } from '../iframe-scripts/storage-sdk.js';

interface StorageApi {
  save(path: string, data: unknown): Promise<unknown>;
  read(path: string, options?: { as?: string }): Promise<unknown>;
  list(dirPath?: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  url(path: string): string;
  path(ref: unknown): string | null;
}

/**
 * Install the SDK over a stub window, and report the URL each call fetched.
 *
 * `api` models app-origin isolation: the app is served from its own origin and
 * `__yaar_api` carries the desktop origin the `/api` calls must cross to.
 */
function installStorage(api?: string) {
  const fetched: string[] = [];
  const search = api ? `?__yaar_token=tok-123&__yaar_api=${encodeURIComponent(api)}` : '';
  const location = {
    search,
    origin: 'http://localhost:8000',
    href: `http://localhost:8000/api/apps/slides-lite/dist/index.html${search}`,
  };
  const window = {
    __YAAR_TOKEN__: 'tok-123',
    fetch(input: unknown) {
      fetched.push(String(input));
      return Promise.resolve(new Response('{}', { headers: { 'content-type': 'text/plain' } }));
    },
  } as Record<string, unknown>;

  // `window`, `location` and `fetch` are parameters, so they shadow Bun's globals inside.
  new Function('window', 'location', 'fetch', IFRAME_STORAGE_SDK_SCRIPT)(
    window,
    location,
    window.fetch,
  );

  return { storage: (window.yaar as { storage: StorageApi }).storage, fetched };
}

const { storage } = installStorage();

describe('storagePath — the four spellings of one file', () => {
  it('passes a bare storage-root-relative path through', () => {
    expect(storage.path('shared/anima/dragon.png')).toBe('shared/anima/dragon.png');
    expect(storage.path('apps/slides-lite/decks/a.json')).toBe('apps/slides-lite/decks/a.json');
  });

  it('reduces the flat URI dialect', () => {
    expect(storage.path('yaar://storage/shared/anima/dragon.png')).toBe('shared/anima/dragon.png');
  });

  it('reduces the namespaced URI dialect — the one four apps dropped', () => {
    expect(storage.path('yaar://apps/anima/storage/generated/x.png')).toBe(
      'apps/anima/generated/x.png',
    );
  });

  it('reduces the REST URL, relative or absolute', () => {
    expect(storage.path('/api/storage/shared/x.png')).toBe('shared/x.png');
    expect(storage.path('api/storage/shared/x.png')).toBe('shared/x.png');
    expect(storage.path('http://localhost:8000/api/storage/shared/x.png')).toBe('shared/x.png');
  });

  it('decodes the REST form, so a url() round-trip does not double-encode', () => {
    const encoded = storage.url('shared/my folder/a+b.png');
    expect(storage.path(encoded.split('?')[0])).toBe('shared/my folder/a+b.png');
  });

  it('leaves `self` for the server to expand', () => {
    // Expanding it here would be a second copy of a mapping the access gate owns —
    // and simply wrong under a devtools preview, where the principal is `preview--{id}`.
    expect(storage.path('yaar://apps/self/storage/decks/a.json')).toBe('apps/self/decks/a.json');
  });

  it('treats a bare namespace root as the tree it names', () => {
    expect(storage.path('yaar://storage')).toBe('');
    expect(storage.path('yaar://storage/')).toBe('');
    expect(storage.path('yaar://apps/self/storage')).toBe('apps/self');
    expect(storage.path('yaar://apps/self/storage/')).toBe('apps/self');
  });

  it('normalizes leading slashes and surrounding whitespace', () => {
    expect(storage.path('  /shared/x.png  ')).toBe('shared/x.png');
    expect(storage.path('///shared/x.png')).toBe('shared/x.png');
  });
});

describe('storagePath — what is not a storage reference', () => {
  it('refuses a remote URL and a data URL', () => {
    // The reason slides-lite keeps images in storage at all: a link only becomes pixels
    // at export time, where it needs a network fetch and the yaar://http permission.
    expect(storage.path('https://example.com/dragon.png')).toBeNull();
    // An absolute URL names storage only through the REST route — which origin served
    // it does not matter (under isolation the API is a sibling origin), but the path
    // does: /a/api/storage/… is somebody else's URL space.
    expect(storage.path('http://example.com/api/storage/x.png')).toBe('x.png');
    expect(storage.path('http://example.com/a/api/storage/x.png')).toBeNull();
    expect(storage.path('data:image/png;base64,AAAA')).toBeNull();
    expect(storage.path('blob:http://localhost:8000/abc')).toBeNull();
  });

  it('refuses a yaar:// resource that is not storage', () => {
    expect(storage.path('yaar://apps/anima/db/scenes')).toBeNull();
    expect(storage.path('yaar://windows/w1')).toBeNull();
    expect(storage.path('yaar://config/settings')).toBeNull();
  });

  it('refuses traversal in every dialect', () => {
    expect(storage.path('apps/self/../vault/secrets.json')).toBeNull();
    expect(storage.path('yaar://storage/shared/../apps/vault/x')).toBeNull();
    expect(storage.path('yaar://apps/self/storage/../../x')).toBeNull();
    expect(storage.path('/api/storage/../x')).toBeNull();
  });

  it('refuses an absent or non-string reference', () => {
    expect(storage.path('')).toBeNull();
    expect(storage.path('   ')).toBeNull();
    expect(storage.path(undefined)).toBeNull();
    expect(storage.path(null)).toBeNull();
    expect(storage.path(42)).toBeNull();
  });
});

describe('every method accepts every spelling', () => {
  it('fetches the same URL whichever dialect it was given', async () => {
    const { storage: s, fetched } = installStorage();
    for (const ref of [
      'shared/x.png',
      'yaar://storage/shared/x.png',
      '/api/storage/shared/x.png',
    ]) {
      await s.read(ref);
    }
    expect(fetched).toEqual([
      '/api/storage/shared/x.png',
      '/api/storage/shared/x.png',
      '/api/storage/shared/x.png',
    ]);
  });

  it('resolves the namespaced dialect on save, remove and list too', async () => {
    const { storage: s, fetched } = installStorage();
    await s.save('yaar://apps/self/storage/a.txt', 'hi');
    await s.remove('yaar://apps/self/storage/a.txt');
    await s.list('yaar://apps/self/storage/dir');
    expect(fetched).toEqual([
      '/api/storage/apps/self/a.txt',
      '/api/storage/apps/self/a.txt',
      '/api/storage/apps/self/dir?list=true',
    ]);
  });

  it('lists the storage root when given nothing', async () => {
    const { storage: s, fetched } = installStorage();
    await s.list();
    await s.list('');
    expect(fetched).toEqual(['/api/storage/?list=true', '/api/storage/?list=true']);
  });

  it('builds a token-carrying url() from any dialect', () => {
    // A subresource fetch cannot attach a header, so the token has to ride in the query
    // string — the whole reason a hand-built `/api/storage/…` is broken.
    expect(storage.url('yaar://storage/shared/x.png')).toBe(
      '/api/storage/shared/x.png?__yaar_token=tok-123',
    );
  });

  it('crosses to the API origin under app-origin isolation', () => {
    const { storage: s } = installStorage('http://127.0.0.1:8000');
    expect(s.url('yaar://apps/self/storage/x.png')).toBe(
      'http://127.0.0.1:8000/api/storage/apps/self/x.png?__yaar_token=tok-123',
    );
  });

  it('names what it rejected rather than 404ing on a nonsense path', async () => {
    const { storage: s, fetched } = installStorage();
    await expect(s.read('https://example.com/x.png')).rejects.toThrow(
      /is not a storage path.*shared\/x\.png/s,
    );
    expect(() => s.url('yaar://apps/self/db/notes')).toThrow(/is not a storage path/);
    expect(fetched).toEqual([]);
  });
});
