/**
 * The user agent a YAAR tab presents — this Chrome's own, minus the word "Headless".
 *
 * Headless Chrome tells every site what it is: `HeadlessChrome/<v>` in the UA string.
 * Overriding just the string is worse than leaving it: `Emulation.setUserAgentOverride`
 * without `userAgentMetadata` empties `navigator.userAgentData` and drops every
 * `Sec-CH-UA*` header, which no real Chrome does. A hand-written UA was worse again —
 * a fixed old version and a fixed OS that the engine, `navigator.platform`, fonts and
 * WebGL all contradicted.
 *
 * So the identity is *read* from the browser, once per Chrome: a scratch tab loads an
 * HTTPS page that `Fetch` answers locally (Client Hints only exist in a secure context,
 * and a fresh `about:blank` is not one), and reports its real UA and high-entropy hints.
 * Nothing leaves the machine. Every tab then presents exactly that, with "Headless"
 * removed — or, for a mobile session, the same brands and versions on an Android phone.
 */

import { CDPClient } from './cdp.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('browser');

/** Answered by `Fetch` in the scratch tab — `.invalid` never resolves, so nothing is sent. */
const PROBE_URL = 'https://ua-probe.invalid/';
const PROBE_TIMEOUT_MS = 5_000;

/** CDP `Emulation.UserAgentMetadata`; the field names match `getHighEntropyValues`. */
interface UserAgentMetadata {
  brands: { brand: string; version: string }[];
  fullVersionList: { brand: string; version: string }[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  /** Only on a Chrome new enough to report it; left out otherwise. */
  formFactors?: string[];
}

export interface BrowserIdentity {
  /** `navigator.userAgent`, with `HeadlessChrome/` already turned into `Chrome/`. */
  userAgent: string;
  metadata: UserAgentMetadata;
}

/** `Emulation.setUserAgentOverride` params. */
export interface UserAgentOverride {
  userAgent: string;
  platform?: string;
  userAgentMetadata?: UserAgentMetadata;
}

const READ_IDENTITY = `(async () => ({
  userAgent: navigator.userAgent,
  metadata: await navigator.userAgentData.getHighEntropyValues(
    ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors'],
  ),
}))()`;

function unheadless(userAgent: string): string {
  return userAgent.replace('HeadlessChrome/', 'Chrome/');
}

/**
 * Read the identity of the Chrome behind `debuggerUrl`, a tab this call may use up:
 * it is navigated and then closed. `null` when anything fails — the caller falls back
 * to {@link userAgentOverride}'s no-identity path.
 */
export async function readBrowserIdentity(debuggerUrl: string): Promise<BrowserIdentity | null> {
  let cdp: CDPClient | null = null;
  try {
    const client = await CDPClient.connect(debuggerUrl);
    cdp = client;
    client.on('Fetch.requestPaused', (params: unknown) => {
      const { requestId } = params as { requestId: string };
      client
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
          body: '',
        })
        .catch(() => {});
    });
    await client.send('Fetch.enable', { patterns: [{ urlPattern: `${PROBE_URL}*` }] });
    await client.send('Page.enable');
    const loaded = client.waitForEvent('Page.loadEventFired', PROBE_TIMEOUT_MS);
    await client.send('Page.navigate', { url: PROBE_URL }, PROBE_TIMEOUT_MS);
    await loaded;
    const { result, exceptionDetails } = await client.send(
      'Runtime.evaluate',
      { expression: READ_IDENTITY, awaitPromise: true, returnByValue: true },
      PROBE_TIMEOUT_MS,
    );
    const value = result?.value as BrowserIdentity | undefined;
    if (exceptionDetails || typeof value?.userAgent !== 'string' || !value.metadata) {
      log.warn('could not read the browser identity', { reason: 'probe page returned nothing' });
      return null;
    }
    const { brands, fullVersionList, platform, platformVersion, architecture, model } =
      value.metadata;
    const { mobile, bitness, wow64, formFactors } = value.metadata;
    return {
      userAgent: unheadless(value.userAgent),
      metadata: {
        brands,
        fullVersionList,
        platform,
        platformVersion,
        architecture,
        model,
        mobile,
        bitness,
        wow64,
        ...(formFactors ? { formFactors } : {}),
      },
    };
  } catch (err) {
    log.warn('could not read the browser identity', { err });
    return null;
  } finally {
    await cdp?.send('Page.close', {}, 2_000).catch(() => {});
    cdp?.close();
  }
}

/** The Chrome major version in a UA string (`Chrome/155.0.0.0` → `155`). */
function majorVersion(userAgent: string): string {
  return userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '0';
}

/** What Chrome on an Android phone sends since UA reduction: the device fields are frozen. */
function androidUserAgent(major: string): string {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

const ANDROID_PLATFORM = 'Linux armv81';

/**
 * The override a tab should carry, or `null` for none.
 *
 * With an identity, a desktop tab presents it unchanged, and a mobile tab presents its
 * brands and versions on a Pixel 8. Without one (the probe failed, or this is the
 * user's own Chrome, which is never probed), the UA string is all there is to go on:
 * a real window already tells the truth and is left alone, a headless one loses only
 * the word "Headless".
 */
export async function userAgentOverride(
  cdp: CDPClient,
  identity: BrowserIdentity | null,
  mobile: boolean,
): Promise<UserAgentOverride | null> {
  if (identity) {
    if (!mobile) return { userAgent: identity.userAgent, userAgentMetadata: identity.metadata };
    const { brands, fullVersionList } = identity.metadata;
    return {
      userAgent: androidUserAgent(majorVersion(identity.userAgent)),
      platform: ANDROID_PLATFORM,
      userAgentMetadata: {
        brands,
        fullVersionList,
        platform: 'Android',
        platformVersion: '14.0.0',
        architecture: '',
        model: 'Pixel 8',
        mobile: true,
        bitness: '',
        wow64: false,
        ...(identity.metadata.formFactors ? { formFactors: ['Mobile'] } : {}),
      },
    };
  }

  const version = (await cdp.send('Browser.getVersion').catch(() => null)) as {
    userAgent?: unknown;
  } | null;
  const userAgent = version?.userAgent;
  if (typeof userAgent !== 'string') return null;
  if (mobile) {
    return { userAgent: androidUserAgent(majorVersion(userAgent)), platform: ANDROID_PLATFORM };
  }
  if (!userAgent.includes('HeadlessChrome/')) return null;
  return { userAgent: unheadless(userAgent) };
}
