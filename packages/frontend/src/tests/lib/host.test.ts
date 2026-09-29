/**
 * `getHost()` is the one gate between the shell and the native window's `window.yaarHost`.
 * No host, or one speaking another contract version, must read as "no host" so every call
 * site keeps its browser path.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { HOST_DOWNLOAD_MAX_BYTES, YAAR_HOST_VERSION, type YaarHost } from '@yaar/shared';
import { getHost, hostCan, hostSaveToast, hostSummary, saveViaHost } from '@/lib/host';

function fakeHost(over: Partial<YaarHost> = {}): YaarHost {
  return {
    version: YAAR_HOST_VERSION,
    platform: 'macos',
    caps: ['download', 'clipboard'],
    download: async (f) => ({ savedTo: `~/Downloads/${f.name}` }),
    clipboard: { readText: async () => 'x', writeText: async () => {} },
    openExternal: () => {},
    on: () => () => {},
    ...over,
  };
}

afterEach(() => {
  delete window.yaarHost;
});

describe('getHost', () => {
  it('is null with no host', () => {
    expect(getHost()).toBeNull();
    expect(hostCan('download')).toBe(false);
    expect(hostSummary()).toBeNull();
  });

  it('accepts a host of the current version', () => {
    const host = fakeHost();
    window.yaarHost = host;
    expect(getHost()).toBe(host);
    expect(hostCan('download')).toBe(true);
    expect(hostCan('share')).toBe(false);
    expect(hostSummary()).toEqual({ platform: 'macos', caps: ['download', 'clipboard'] });
  });

  it('rejects a host of another version', () => {
    window.yaarHost = { ...fakeHost(), version: 99 } as unknown as YaarHost;
    expect(getHost()).toBeNull();
  });

  it('rejects a non-object', () => {
    (window as unknown as { yaarHost: unknown }).yaarHost = 'nope';
    expect(getHost()).toBeNull();
  });
});

describe('saveViaHost', () => {
  it('reports where the file landed', async () => {
    const result = await saveViaHost(fakeHost(), {
      name: 'a.txt',
      mime: 'text/plain',
      bytes: new ArrayBuffer(3),
    });
    expect(result).toEqual({ ok: true, savedTo: '~/Downloads/a.txt' });
    expect(hostSaveToast('a.txt', result).message).toBe('Saved to ~/Downloads/a.txt');
  });

  it('turns a rejection into an error result', async () => {
    const host = fakeHost({
      download: async () => {
        throw new Error('disk full');
      },
    });
    const result = await saveViaHost(host, { name: 'a', mime: '', bytes: new ArrayBuffer(1) });
    expect(result).toEqual({ ok: false, error: 'disk full' });
    expect(hostSaveToast('a', result).variant).toBe('error');
  });

  it('refuses a file over the cap without calling the host', async () => {
    let called = false;
    const host = fakeHost({
      download: async () => {
        called = true;
        return { savedTo: '' };
      },
    });
    const big = { byteLength: HOST_DOWNLOAD_MAX_BYTES + 1 } as ArrayBuffer;
    const result = await saveViaHost(host, { name: 'big', mime: '', bytes: big });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
