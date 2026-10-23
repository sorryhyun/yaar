/**
 * Tests for `userAgentOverride` — the user agent a YAAR tab presents.
 *
 * The identity probe itself (`readBrowserIdentity`) needs a real Chrome to answer
 * `getHighEntropyValues`; these cover what is done with its answer, and the
 * fallback when there is none.
 */
import { describe, it, expect } from 'bun:test';
import { userAgentOverride, type BrowserIdentity } from '../lib/browser/ua-identity.js';
import type { CDPClient } from '../lib/browser/cdp.js';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const BRANDS = [
  { brand: 'Google Chrome', version: '155' },
  { brand: 'Chromium', version: '155' },
  { brand: 'Not(A:Brand', version: '24' },
];
const FULL_VERSIONS = [
  { brand: 'Google Chrome', version: '155.0.8059.85' },
  { brand: 'Chromium', version: '155.0.8059.85' },
  { brand: 'Not(A:Brand', version: '24.0.0.0' },
];

const identity: BrowserIdentity = {
  userAgent: MAC_UA,
  metadata: {
    brands: BRANDS,
    fullVersionList: FULL_VERSIONS,
    platform: 'macOS',
    platformVersion: '26.6.2',
    architecture: 'arm',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
    formFactors: ['Desktop'],
  },
};

/** A CDP socket whose `Browser.getVersion` reports `userAgent`. */
function cdpReporting(userAgent: string | undefined): CDPClient {
  return {
    send: (method: string) =>
      Promise.resolve(method === 'Browser.getVersion' && userAgent ? { userAgent } : {}),
  } as unknown as CDPClient;
}

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';

describe('userAgentOverride', () => {
  it('a desktop tab presents the identity unchanged, client hints included', async () => {
    expect(await userAgentOverride(cdpReporting(undefined), identity, false)).toEqual({
      userAgent: MAC_UA,
      userAgentMetadata: identity.metadata,
    });
  });

  it("a mobile tab keeps the browser's brands and versions on an Android phone", async () => {
    expect(await userAgentOverride(cdpReporting(undefined), identity, true)).toEqual({
      userAgent: ANDROID_UA,
      platform: 'Linux armv81',
      userAgentMetadata: {
        brands: BRANDS,
        fullVersionList: FULL_VERSIONS,
        platform: 'Android',
        platformVersion: '14.0.0',
        architecture: '',
        model: 'Pixel 8',
        mobile: true,
        bitness: '',
        wow64: false,
        formFactors: ['Mobile'],
      },
    });
  });

  it('without an identity, a headless UA loses only the word "Headless"', async () => {
    const headless = MAC_UA.replace('Chrome/', 'HeadlessChrome/');
    expect(await userAgentOverride(cdpReporting(headless), null, false)).toEqual({
      userAgent: MAC_UA,
    });
  });

  it('without an identity, a real window is left alone', async () => {
    expect(await userAgentOverride(cdpReporting(MAC_UA), null, false)).toBeNull();
  });

  it('without an identity, a mobile tab still gets an Android UA at the real version', async () => {
    expect(await userAgentOverride(cdpReporting(MAC_UA), null, true)).toEqual({
      userAgent: ANDROID_UA,
      platform: 'Linux armv81',
    });
  });

  it('a browser that will not say what it is gets no override', async () => {
    expect(await userAgentOverride(cdpReporting(undefined), null, false)).toBeNull();
  });
});
