/**
 * `launchAppWindow` — the one way the desktop opens an app window on its own, shared by
 * the desktop icons and by links routed to an app (`open-url.ts`).
 *
 * The two used to be separate copies of the same sequence, and had drifted. What they
 * both depend on is pinned here: a window never opens without a token (it could not make
 * a single verb call), and the window is not reported to the agent by the launch itself,
 * because the link path may still close it again.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { cascadeWindowBounds } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { launchAppWindow, recordOpened, type InstalledApp } from '@/store/iframe-bridge';

const MONITOR_ID = '0';
const NOTES: InstalledApp = { id: 'notes', name: 'Notes', run: 'yaar://apps/notes/index.html' };

interface TokenRequest {
  url: string;
  body: Record<string, unknown>;
}

let requests: TokenRequest[] = [];
/** What the stubbed `/api/iframe-token` answers with. */
let tokenReply: () => Response;

const realFetch = globalThis.fetch;

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetStore() {
  useDesktopStore.setState({
    windows: {},
    zOrder: [],
    focusedWindowId: null,
    activeMonitorId: MONITOR_ID,
    pendingInteractions: [],
    sessionId: 'session-1',
  });
}

function openedWindows() {
  return Object.values(useDesktopStore.getState().windows);
}

describe('launchAppWindow', () => {
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('/api/iframe-token')) throw new Error(`unexpected fetch: ${url}`);
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return tokenReply();
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    resetStore();
    requests = [];
    tokenReply = () => jsonOk({ token: 'iframe-token-1' });
  });

  it('mints a token for the app, then opens its window with it', async () => {
    const opened = await launchAppWindow(NOTES);

    expect(requests).toEqual([
      {
        url: '/api/iframe-token',
        body: { windowId: 'notes', sessionId: 'session-1', appId: 'notes', monitorId: MONITOR_ID },
      },
    ]);
    const [win] = openedWindows();
    expect(win.id).toBe(`${MONITOR_ID}/notes`);
    expect(win.appId).toBe('notes');
    expect(win.title).toBe('Notes');
    expect(win.iframeToken).toBe('iframe-token-1');
    expect(win.content).toEqual({ renderer: 'iframe', data: NOTES.run });
    expect(opened).toMatchObject({ windowId: 'notes', appId: 'notes', monitorId: MONITOR_ID });
  });

  it('does not report the window to the agent until the caller does', async () => {
    const opened = await launchAppWindow(NOTES);
    expect(useDesktopStore.getState().pendingInteractions).toHaveLength(0);

    recordOpened(opened);
    const [interaction] = useDesktopStore.getState().pendingInteractions;
    expect(interaction).toMatchObject({
      type: 'window.create',
      windowId: 'notes',
      windowTitle: 'Notes',
      appId: 'notes',
      monitorId: MONITOR_ID,
      bounds: opened.bounds,
    });
    expect(interaction.details).toBeUndefined();
  });

  it('opens on the monitor it is given, not the active one', async () => {
    await launchAppWindow(NOTES, { monitorId: '2' });

    expect(requests[0].body.monitorId).toBe('2');
    expect(openedWindows()[0].id).toBe('2/notes');
  });

  it('appends a launch query to the run URL', async () => {
    await launchAppWindow(NOTES, { runQuery: 'url=x' });
    await launchAppWindow(
      { id: 'q', name: 'Q', run: 'yaar://apps/q/index.html?mode=a' },
      { runQuery: 'url=y' },
    );

    const data = openedWindows().map((w) => w.content.data);
    expect(data).toEqual([`${NOTES.run}?url=x`, 'yaar://apps/q/index.html?mode=a&url=y']);
  });

  it("cascades past the windows already open, at the manifest's size when it has one", async () => {
    const first = await launchAppWindow(NOTES);
    const second = await launchAppWindow({
      id: 'panel',
      name: 'Panel',
      run: 'yaar://apps/panel/index.html',
      defaultWidth: 320,
      defaultHeight: 240,
      variant: 'widget',
      frameless: true,
    });

    expect(second.bounds).not.toEqual(first.bounds);
    const viewport = { w: globalThis.innerWidth, h: globalThis.innerHeight };
    expect(second.bounds).toEqual(cascadeWindowBounds(1, 320, 240, viewport));
    const panel = openedWindows().find((w) => w.appId === 'panel');
    expect(panel?.variant).toBe('widget');
    expect(panel?.frameless).toBe(true);
  });

  it('opens nothing when the mint fails', async () => {
    tokenReply = () => new Response('nope', { status: 403 });
    await expect(launchAppWindow(NOTES)).rejects.toThrow('iframe-token request failed (403)');

    tokenReply = () => jsonOk({ token: '' });
    await expect(launchAppWindow(NOTES)).rejects.toThrow('iframe-token response carried no token');

    expect(openedWindows()).toHaveLength(0);
  });

  it('opens nothing without a session or a run URL, and asks for no token', async () => {
    await expect(launchAppWindow({ id: 'bare', name: 'Bare' })).rejects.toThrow();
    useDesktopStore.setState({ sessionId: null });
    await expect(launchAppWindow(NOTES)).rejects.toThrow();

    expect(requests).toHaveLength(0);
    expect(openedWindows()).toHaveLength(0);
  });
});
