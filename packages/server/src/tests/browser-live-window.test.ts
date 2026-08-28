/**
 * `web.open(url, { visible: true, live: true })` must open the Browser-app window
 * already streaming.
 *
 * The flag can only reach a freshly created app window through its content URI —
 * nothing server-side can talk to the app until it has registered its protocol — so
 * what these tests pin is the URI `openBrowserWindow` hands to the window verb. Before
 * `live`, an app that needed a live window had to poll `listTabs`, then retry
 * `set_live_mode` against the window until the iframe came up.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test';

const created: Array<{ windowId: string; content: string }> = [];

mock.module('../features/window/create.js', () => ({
  handleCreate: mock((windowId: string, payload: { content: string }) => {
    created.push({ windowId, content: payload.content });
    return Promise.resolve({ isError: false, content: [] });
  }),
}));

// Spread, not replaced: `domains.js` has other exports that other modules in this
// process import, and a bare stub makes those a load-time SyntaxError.
const domains = await import('../features/config/domains.js');
mock.module('../features/config/domains.js', () => ({
  ...domains,
  isDomainAllowed: () => Promise.resolve(true),
}));

const { handleCreate, handleOpen } = await import('../features/browser/actions.js');

/** The slice of BrowserProvider these two actions touch. */
function stubPool(bid: string) {
  const session = {
    mobile: false,
    windowId: undefined as string | undefined,
    currentUrl: '',
    currentTitle: '',
    navigate: () => Promise.resolve({ url: 'https://example.com/', title: 'Example' }),
  };
  return {
    pool: {
      getSession: () => undefined,
      createSession: () => Promise.resolve({ session, browserId: bid }),
    },
    session,
  };
}

describe('browser window live launch parameter', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('create without live opens the plain window', async () => {
    const { pool } = stubPool('0');
    await handleCreate(pool as any, '0', {});
    expect(created).toHaveLength(1);
    expect(created[0].content).toBe('yaar://apps/browser?browserId=0');
  });

  it('create with live: true adds ?live=1 to the content URI', async () => {
    const { pool } = stubPool('0');
    await handleCreate(pool as any, '0', { live: true });
    expect(created[0].content).toBe('yaar://apps/browser?browserId=0&live=1');
  });

  it('open with live: true adds ?live=1, keeping the browserId first', async () => {
    const { pool } = stubPool('login');
    await handleOpen(pool as any, 'login', { url: 'https://example.com/', live: true });
    expect(created[0].windowId).toBe('browser-login');
    expect(created[0].content).toBe('yaar://apps/browser?browserId=login&live=1');
  });

  it('live is ignored when no window is opened at all', async () => {
    const { pool } = stubPool('0');
    await handleOpen(pool as any, '0', {
      url: 'https://example.com/',
      visible: false,
      live: true,
    });
    expect(created).toHaveLength(0);
  });
});
