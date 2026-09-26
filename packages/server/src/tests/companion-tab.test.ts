/**
 * The companion desktop's two decisions that are not obvious from its call site: when it
 * is wanted at all, and what URL it opens.
 *
 * Both are cheap to get subtly wrong and expensive to notice. A default that turns this on
 * everywhere buys a second Chromium and a second live iframe per open app window on every
 * desktop that never needed one; a URL missing `?ui=desktop` gives a companion that renders
 * the phone shell, where only the frontmost window is mounted — so a capture of any other
 * window finds nothing in the DOM and the whole point is lost, silently.
 */
import { describe, it, expect, afterEach } from 'bun:test';

const ORIGINAL = process.env.YAAR_COMPANION_TAB;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YAAR_COMPANION_TAB;
  else process.env.YAAR_COMPANION_TAB = ORIGINAL;
});

describe('wantsCompanionTab', () => {
  it('is off by default anywhere but Android', async () => {
    delete process.env.YAAR_COMPANION_TAB;
    const { wantsCompanionTab } = await import('../features/companion/companion-tab.js');
    // The suite does not run on Android; asserting the platform keeps this honest if it ever does.
    expect(process.platform).not.toBe('android');
    expect(wantsCompanionTab()).toBe(false);
  });

  it('is forced on by YAAR_COMPANION_TAB=1', async () => {
    process.env.YAAR_COMPANION_TAB = '1';
    const { wantsCompanionTab } = await import('../features/companion/companion-tab.js');
    expect(wantsCompanionTab()).toBe(true);
  });

  it('is forced off by YAAR_COMPANION_TAB=0', async () => {
    process.env.YAAR_COMPANION_TAB = '0';
    const { wantsCompanionTab } = await import('../features/companion/companion-tab.js');
    expect(wantsCompanionTab()).toBe(false);
  });
});

describe('the idle sweep', () => {
  it('spares a pinned session', async () => {
    const { CdpBrowserProvider } = await import('../lib/browser/cdp-provider.js');

    // Two sessions, both idle past any threshold; only one is pinned.
    const stale = {
      screencasting: false,
      pinned: false,
      lastActivity: 0,
      windowId: undefined,
      close: async () => {},
    };
    const companion = {
      screencasting: false,
      pinned: true,
      lastActivity: 0,
      windowId: undefined,
      close: async () => {},
    };

    const provider = Object.create(CdpBrowserProvider.prototype) as InstanceType<
      typeof CdpBrowserProvider
    >;
    const records = new Map<string, { session?: unknown; ephemeral: boolean; restarts: number }>([
      ['stale', { session: stale, ephemeral: false, restarts: 0 }],
      ['companion', { session: companion, ephemeral: false, restarts: 0 }],
    ]);
    Object.assign(provider, {
      records,
      targets: new Map(),
      ownsChrome: false,
      closeEndpoint: async () => {},
    });

    await (provider as unknown as { cleanupIdle(): Promise<void> }).cleanupIdle();

    expect(records.get('stale')?.session).toBeUndefined();
    expect(records.get('companion')?.session).toBe(companion);
  });
});
