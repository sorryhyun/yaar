import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

/**
 * `createBlobUrlCache` replaced crawl's two hand-rolled copies, and what those
 * copies had to get right is lifetime: evict the least recently used and revoke
 * it, never cache a failure, never leave an evicted-while-loading URL unrevoked.
 *
 * Globals are stubbed by hand — `URL.createObjectURL` and `Image` are the
 * whole surface — rather than through happy-dom.
 */

const made: string[] = [];
const revoked: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
let seq = 0;
URL.createObjectURL = () => {
  const url = `blob:test/${++seq}` as const;
  made.push(url);
  return url;
};
URL.revokeObjectURL = (url: string) => void revoked.push(url);

const decodedSrcs: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const prevImage = g.Image;
g.Image = class {
  src = '';
  decode() {
    decodedSrcs.push(this.src);
    return Promise.resolve();
  }
};

afterAll(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  g.Image = prevImage;
});

const { createBlobUrlCache, decodeImage } = await import('../shims/yaar/image-cache.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const blob = () => Promise.resolve(new Blob(['x']));

beforeEach(() => {
  made.length = 0;
  revoked.length = 0;
  decodedSrcs.length = 0;
});

describe('createBlobUrlCache', () => {
  test('a second get reuses the load', async () => {
    let loads = 0;
    const cache = createBlobUrlCache({ max: 4, load: () => (loads++, blob()) });
    const a = await cache.get('a');
    expect(await cache.get('a')).toBe(a);
    expect(loads).toBe(1);
  });

  test('peek answers only once the load has settled', async () => {
    const cache = createBlobUrlCache({ max: 4, load: blob });
    const pending = cache.get('a');
    expect(cache.peek('a')).toBeUndefined();
    const url = await pending;
    expect(cache.peek('a')).toBe(url);
  });

  test('evicts and revokes the least recently used, counting a re-get as a use', async () => {
    const cache = createBlobUrlCache({ max: 2, load: blob });
    const a = await cache.get('a');
    const b = await cache.get('b');
    await cache.get('a');
    await cache.get('c');
    await flush();
    expect(revoked).toEqual([b]);
    expect(cache.peek('a')).toBe(a);
    expect(cache.peek('b')).toBeUndefined();
  });

  test('a URL evicted while still loading is revoked when it lands', async () => {
    let release!: () => void;
    const slow = new Promise<Blob>((r) => (release = () => r(new Blob(['x']))));
    const cache = createBlobUrlCache({ max: 1, load: (k: string) => (k === 'a' ? slow : blob()) });
    const a = cache.get('a');
    await cache.get('b');
    release();
    const url = await a;
    await flush();
    expect(revoked).toContain(url);
    expect(cache.peek('a')).toBeUndefined();
  });

  test('a failed load is not cached', async () => {
    let fail = true;
    const cache = createBlobUrlCache({
      max: 4,
      load: () => (fail ? Promise.reject(new Error('404')) : blob()),
    });
    await expect(cache.get('a')).rejects.toThrow('404');
    fail = false;
    expect(await cache.get('a')).toStartWith('blob:');
  });

  test('keyOf identifies non-string keys', async () => {
    let loads = 0;
    const cache = createBlobUrlCache<{ id: string }>({
      max: 4,
      load: () => (loads++, blob()),
      keyOf: (p) => p.id,
    });
    await cache.get({ id: 'p1' });
    await cache.get({ id: 'p1' });
    expect(loads).toBe(1);
  });

  test('clear revokes everything', async () => {
    const cache = createBlobUrlCache({ max: 4, load: blob });
    const a = await cache.get('a');
    const b = await cache.get('b');
    cache.clear();
    await flush();
    expect(revoked.sort()).toEqual([a, b].sort());
    expect(cache.peek('a')).toBeUndefined();
  });

  test('preload fetches and decodes, and swallows failure', async () => {
    const cache = createBlobUrlCache({
      max: 4,
      load: (k: string) => (k === 'bad' ? Promise.reject(new Error('x')) : blob()),
    });
    cache.preload('a');
    cache.preload('bad');
    await flush();
    expect(decodedSrcs).toEqual([cache.peek('a')!]);
  });
});

describe('decodeImage', () => {
  test('decodes a URL once while it stays held', async () => {
    await decodeImage('blob:held');
    await decodeImage('blob:held');
    expect(decodedSrcs).toEqual(['blob:held']);
  });
});
