/**
 * `lib/appOrigin` — where an installed app's iframe is served from locally, and the
 * once-per-load probe that decides whether per-app `<appId>.localhost` origins work here.
 *
 * The fallback is a silent security downgrade (apps share `127.0.0.1` again), so what is
 * pinned is that it happens on every kind of failure, that the decision is made once and
 * shared, and that it is left where it can be seen.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import {
  IFRAME_ORIGIN_DATA_ATTR,
  appOriginFor,
  decideAppOriginPlan,
  getAppOriginPlan,
  localAppOrigin,
  resetAppOriginPlan,
  sharedAppOrigin,
  subscribeAppOriginPlan,
} from '@/lib/appOrigin';
import { getIframeTargetOrigin } from '@/store/iframe-bridge/target';

function setUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(url);
}

const originalHref = window.location.href;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realInfo = console.info;

let probed: string[] = [];
/** What the stubbed probe answers with; a throw is a name that never resolved. */
let probeReply: () => Response | Promise<Response>;

function health(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  setUrl('https://localhost:8443/');
  resetAppOriginPlan();
  probed = [];
  probeReply = () => health({ status: 'ok', originBoundary: 'loopback-subdomain' });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    probed.push(String(input instanceof Request ? input.url : input));
    return probeReply();
  }) as typeof fetch;
  console.warn = () => {};
  console.info = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.info = realInfo;
  resetAppOriginPlan();
});

afterAll(() => setUrl(originalHref));

describe('deriving an app origin', () => {
  it("names the app's own *.localhost on the desktop's scheme and port", () => {
    expect(appOriginFor('notes')).toBe('https://notes.localhost:8443');
    setUrl('http://localhost/');
    expect(appOriginFor('notes')).toBe('http://notes.localhost');
  });

  it('refuses an id that cannot be one hostname label', () => {
    expect(appOriginFor('a'.repeat(64))).toBeNull();
    expect(appOriginFor('trailing-')).toBeNull();
    expect(appOriginFor('xn--abc')).toBeNull();
    expect(appOriginFor('Notes')).toBeNull();
    expect(appOriginFor('a'.repeat(63))).toBe(`https://${'a'.repeat(63)}.localhost:8443`);
  });

  it('derives nothing off localhost', () => {
    setUrl('https://box.ts.net/');
    expect(appOriginFor('notes')).toBeNull();
    expect(sharedAppOrigin()).toBeNull();
    expect(localAppOrigin('notes', true)).toBeNull();
  });

  it("falls back to the shared alias when per-app is off or the id can't be a label", () => {
    expect(localAppOrigin('notes', false)).toBe('https://127.0.0.1:8443');
    expect(localAppOrigin('trailing-', true)).toBe('https://127.0.0.1:8443');
    expect(localAppOrigin(undefined, true)).toBe('https://127.0.0.1:8443');
    expect(localAppOrigin('notes', true)).toBe('https://notes.localhost:8443');
  });
});

describe('deciding per-app origins, once per load', () => {
  it('goes per-app when probe.localhost answers in the per-app mode', async () => {
    expect(await decideAppOriginPlan()).toBe('per-app');
    expect(probed).toEqual(['https://probe.localhost:8443/health']);
    expect(getAppOriginPlan()).toBe('per-app');
    expect(document.documentElement.dataset.appOrigins).toBe('per-app');
  });

  it('falls back to shared on every kind of failure', async () => {
    const failures: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => health({ status: 'ok', originBoundary: 'loopback-alias' }),
      () => health({ error: 'nope' }, 500),
      () => new Response('not json', { status: 200 }),
    ];
    for (const failure of failures) {
      resetAppOriginPlan();
      probeReply = failure;
      expect(await decideAppOriginPlan()).toBe('shared');
      expect(document.documentElement.dataset.appOrigins).toBe('shared');
    }
  });

  it('says so when it falls back', async () => {
    const warned: string[] = [];
    console.warn = (msg: string) => warned.push(msg);
    probeReply = () => Promise.reject(new TypeError('Failed to fetch'));
    await decideAppOriginPlan();
    expect(warned.join('\n')).toContain('share the 127.0.0.1');
  });

  it('does not probe off localhost', async () => {
    setUrl('http://192.168.0.5:8000/');
    expect(await decideAppOriginPlan()).toBe('shared');
    expect(probed).toEqual([]);
  });

  it('probes once, however many windows ask, and tells every subscriber', async () => {
    let told = 0;
    const unsubscribe = subscribeAppOriginPlan(() => told++);
    const answers = await Promise.all([decideAppOriginPlan(), decideAppOriginPlan()]);
    expect(answers).toEqual(['per-app', 'per-app']);
    expect(await decideAppOriginPlan()).toBe('per-app');
    expect(probed).toHaveLength(1);
    expect(told).toBe(1);
    unsubscribe();
  });
});

describe('posting to an isolated frame', () => {
  it('names the origin the frame was served from, not *', () => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute(IFRAME_ORIGIN_DATA_ATTR, 'https://notes.localhost:8443');
    expect(getIframeTargetOrigin(iframe)).toBe('https://notes.localhost:8443');
  });

  it("keeps * for a frame whose origin it can't know", () => {
    const iframe = document.createElement('iframe');
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => ({
        get origin(): string {
          throw new DOMException('Blocked a frame', 'SecurityError');
        },
      }),
    });
    expect(getIframeTargetOrigin(iframe)).toBe('*');
  });
});
