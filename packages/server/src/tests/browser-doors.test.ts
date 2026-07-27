/**
 * Tests for the Phase-2 two-door browser provider split.
 *
 * `getHeadlessBrowser()` (the `/api/browser` sandbox) and `getLocalBrowser()`
 * (the `yaar://session/browser` real-Chrome door) must be *distinct* singletons
 * bound to different identities, so the user's real browser can't leak out the
 * sandbox door regardless of `YAAR_BROWSER_PROVIDER`.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  getHeadlessBrowser,
  getLocalBrowser,
  isForceHeadless,
  getBrowserProvider,
} from '../lib/browser/index.js';

const ORIGINAL = process.env.YAAR_BROWSER_PROVIDER;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YAAR_BROWSER_PROVIDER;
  else process.env.YAAR_BROWSER_PROVIDER = ORIGINAL;
});

describe('two-door browser providers', () => {
  it('getHeadlessBrowser is a stable singleton with no user identity', () => {
    const a = getHeadlessBrowser();
    const b = getHeadlessBrowser();
    expect(a).toBe(b);
    expect(a.controlsUserBrowser).toBe(false);
  });

  it('getLocalBrowser is a stable singleton that controls the user browser', () => {
    const a = getLocalBrowser();
    const b = getLocalBrowser();
    expect(a).toBe(b);
    expect(a.controlsUserBrowser).toBe(true);
  });

  it('the two doors are different instances', () => {
    expect(getHeadlessBrowser()).not.toBe(getLocalBrowser());
  });

  it('the deprecated getBrowserProvider() alias is always the headless instance', () => {
    process.env.YAAR_BROWSER_PROVIDER = 'headless';
    // getBrowserProvider() has no production callers left (both live doors are reached
    // by name — getHeadlessBrowser() / getLocalBrowser()); it stays pinned to headless
    // regardless of the env var, which only isForceHeadless() reads.
    expect(getBrowserProvider()).toBe(getHeadlessBrowser());
    expect(getBrowserProvider().controlsUserBrowser).toBe(false);
  });

  it('isForceHeadless reflects only the headless opt-out value', () => {
    process.env.YAAR_BROWSER_PROVIDER = 'headless';
    expect(isForceHeadless()).toBe(true);

    process.env.YAAR_BROWSER_PROVIDER = 'local';
    expect(isForceHeadless()).toBe(false);

    delete process.env.YAAR_BROWSER_PROVIDER;
    expect(isForceHeadless()).toBe(false);
  });
});
