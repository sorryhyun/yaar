/**
 * Download capture — the half of `web.download()` that does not need a browser.
 *
 * One {@link DownloadHub} per Chrome sets the download behavior once, on the browser
 * socket, and routes each finished download to the tab it came from by guid. The fakes
 * below play both sockets: the browser socket (`Browser.downloadWillBegin` /
 * `downloadProgress`) and each tab's own (`Page.downloadWillBegin`).
 * Files are real, written where Chrome would write them: `<dir>/<guid>`.
 *
 * The parts that genuinely need Chrome (the behavior holding across tabs attaching and
 * detaching, the injected `<a download>` click) are exercised by driving the app, not here.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadCapture, DownloadHub, type CapturedDownload } from '../lib/browser/downloads.js';
import type { CDPClient } from '../lib/browser/cdp.js';
import { safeDownloadName } from '../features/browser/actions.js';

/** A CDP socket that records handlers; `send` answers with `reply` or throws. */
function fakeSocket(
  reply: (method: string, params?: Record<string, unknown>) => unknown = () => ({}),
) {
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const cdp = {
    on(event: string, handler: (params: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, params });
      return reply(method, params);
    },
  };
  const emit = (event: string, params: unknown) => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  return { cdp: cdp as unknown as CDPClient, emit, sent };
}

let dirs: string[] = [];
let captures: DownloadCapture[] = [];

afterEach(async () => {
  for (const c of captures) await c.dispose();
  captures = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

/** An armed hub over a fresh directory, and the browser socket it is armed on. */
async function armedHub() {
  const dir = await mkdtemp(join(tmpdir(), 'yaar-dl-test-'));
  dirs.push(dir);
  const hub = new DownloadHub(async () => dir, 20);
  const browser = fakeSocket();
  await hub.arm(browser.cdp);
  return { hub, dir, browser };
}

/** One tab: its capture, attached to its own fake page socket, on main frame `frameId`. */
function tab(
  hub: DownloadHub,
  frameId: string,
  onComplete: (d: CapturedDownload) => void = () => {},
) {
  const capture = new DownloadCapture(hub, onComplete);
  captures.push(capture);
  const page = fakeSocket();
  capture.attach(page.cdp);
  capture.noteMainFrame(frameId);
  return { capture, page };
}

let nextGuid = 0;

/**
 * What Chrome does for one download in `frameId`: announce it on the tab's socket (unless
 * `pageEvent` is false) and the browser socket, write `<dir>/<guid>`, report completion.
 */
async function download(
  env: { dir: string; browser: ReturnType<typeof fakeSocket> },
  opts: {
    page?: ReturnType<typeof fakeSocket>;
    frameId: string;
    bytes?: number;
    name?: string;
    url?: string;
    state?: 'completed' | 'canceled';
  },
): Promise<string> {
  const guid = `guid-${++nextGuid}`;
  const begin = {
    guid,
    frameId: opts.frameId,
    url: opts.url ?? 'https://arxiv.test/pdf/2609.02367v1',
    suggestedFilename: opts.name ?? '2609.02367v1.pdf',
  };
  opts.page?.emit('Page.downloadWillBegin', begin);
  env.browser.emit('Browser.downloadWillBegin', begin);
  const file = join(env.dir, guid);
  await writeFile(file, Buffer.alloc(opts.bytes ?? 16, 1));
  env.browser.emit('Browser.downloadProgress', {
    guid,
    state: opts.state ?? 'completed',
    filePath: file,
  });
  return guid;
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(5);
  }
}

/** Longer than the hub's owner grace (20ms here), for asserting that nothing happened. */
const quiet = () => Bun.sleep(80);

describe('DownloadHub', () => {
  it('sets the behavior once, on the browser socket, naming files by guid', async () => {
    const { hub, dir, browser } = await armedHub();
    expect(hub.available).toBe(true);
    expect(browser.sent).toEqual([
      {
        method: 'Browser.setDownloadBehavior',
        params: { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true },
      },
    ]);
    // A tab sets nothing: its socket only listens.
    const { page } = tab(hub, 'A');
    expect(page.sent).toEqual([]);
  });

  it('gives a download to the tab it came from, not to the tab that attached last', async () => {
    // The reported failure: a second tab attaching moved every download into its own
    // directory, so the arXiv tab waited out its timeout with the bytes elsewhere.
    const env = await armedHub();
    const seenA: CapturedDownload[] = [];
    const seenB: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => seenA.push(d));
    tab(env.hub, 'B', (d) => seenB.push(d));

    const guid = await download(env, { page: a.page, frameId: 'A', bytes: 2048 });
    await until(() => seenA.length > 0);
    await quiet();

    expect(seenB).toEqual([]);
    expect(seenA[0]).toMatchObject({
      id: guid,
      url: 'https://arxiv.test/pdf/2609.02367v1',
      // Chrome's derived name, carried by the event: the file itself is named by guid.
      suggestedFilename: '2609.02367v1.pdf',
      bytes: 2048,
      file: join(env.dir, guid),
    });
  });

  it('keeps capturing after another tab goes away', async () => {
    // The other half: a tab's socket detaching used to reset Chrome's behavior, sending
    // the next download to ~/Downloads.
    const env = await armedHub();
    const seenA: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => seenA.push(d));
    const b = tab(env.hub, 'B');
    await b.capture.dispose();

    await download(env, { page: a.page, frameId: 'A' });
    await until(() => seenA.length > 0);
    expect(a.capture.available).toBe(true);
  });

  it('attributes a download from a subframe by the tab socket that announced it', async () => {
    const env = await armedHub();
    const seen: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => seen.push(d));
    await download(env, { page: a.page, frameId: 'iframe-in-A' });
    await until(() => seen.length > 0);
  });

  it('falls back to the main frame id when the tab socket said nothing', async () => {
    const env = await armedHub();
    const seen: CapturedDownload[] = [];
    tab(env.hub, 'A', (d) => seen.push(d));
    await download(env, { frameId: 'A' });
    await until(() => seen.length > 0);
  });

  it('deletes a download no tab can be found for', async () => {
    const env = await armedHub();
    const seen: CapturedDownload[] = [];
    tab(env.hub, 'A', (d) => seen.push(d));
    const guid = await download(env, { frameId: 'someone-else' });
    await until(() => !existsSync(join(env.dir, guid)));
    expect(seen).toEqual([]);
  });

  it('records nothing for a canceled download, and removes its partial file', async () => {
    const env = await armedHub();
    const seen: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => seen.push(d));
    const guid = await download(env, { page: a.page, frameId: 'A', state: 'canceled' });
    await until(() => !existsSync(join(env.dir, guid)));
    await quiet();
    expect(seen).toEqual([]);
  });

  it('records a refusal, and is unavailable until armed on a socket that accepts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yaar-dl-test-'));
    dirs.push(dir);
    const hub = new DownloadHub(async () => dir);
    const capture = new DownloadCapture(hub, () => {});
    captures.push(capture);
    expect(capture.available).toBe(false);

    await hub.arm(
      fakeSocket(() => {
        throw new Error('nope');
      }).cdp,
    );
    expect(hub.available).toBe(false);

    const accepting = fakeSocket();
    await hub.arm(accepting.cdp);
    expect(capture.available).toBe(true);
  });

  it('is unavailable once its browser socket is gone, and again after a re-arm', async () => {
    const { hub, browser } = await armedHub();
    hub.disarm(fakeSocket().cdp); // someone else's socket closing changes nothing
    expect(hub.available).toBe(true);
    hub.disarm(browser.cdp);
    expect(hub.available).toBe(false);
    await hub.arm(fakeSocket().cdp);
    expect(hub.available).toBe(true);
  });

  it('asks for its directory once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yaar-dl-test-'));
    dirs.push(dir);
    let asked = 0;
    const hub = new DownloadHub(async () => {
      asked++;
      return dir;
    });
    await hub.arm(fakeSocket().cdp);
    await hub.arm(fakeSocket().cdp);
    expect(asked).toBe(1);
  });

  it('is unavailable with no hub at all', () => {
    const capture = new DownloadCapture(null, () => {});
    expect(capture.available).toBe(false);
  });
});

describe('DownloadCapture', () => {
  it('claims an id exactly once', async () => {
    const env = await armedHub();
    const a = tab(env.hub, 'A');
    const guid = await download(env, { page: a.page, frameId: 'A', bytes: 8 });
    await until(() => a.capture.list().length > 0);

    expect(a.capture.take(guid)?.bytes).toBe(8);
    expect(a.capture.take(guid)).toBeUndefined();
    expect(a.capture.list()).toEqual([]);
  });

  it('captures the same name again as a new download', async () => {
    // Same paper twice: the name repeats, the guid does not.
    const env = await armedHub();
    const seen: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => seen.push(d));
    await download(env, { page: a.page, frameId: 'A', name: 'paper.pdf', bytes: 2 });
    await download(env, { page: a.page, frameId: 'A', name: 'paper.pdf', bytes: 4 });
    await until(() => seen.length === 2);
    expect(seen.map((d) => d.suggestedFilename)).toEqual(['paper.pdf', 'paper.pdf']);
    expect(new Set(seen.map((d) => d.id)).size).toBe(2);
  });

  it('hands a waited-for download to its waiter alone', async () => {
    // Both at once would double-save it: the action stores the capture it was handed
    // while the announcement sends the app back to claim the very same id.
    const env = await armedHub();
    const announced: CapturedDownload[] = [];
    const a = tab(env.hub, 'A', (d) => announced.push(d));

    const waiting = a.capture.waitForNext(Date.now(), 2_000);
    const guid = await download(env, { page: a.page, frameId: 'A' });

    expect((await waiting).id).toBe(guid);
    expect(announced).toEqual([]);
    expect(a.capture.list()).toEqual([]);
  });

  it('settles a waiter only with a download that finished after it started waiting', async () => {
    const env = await armedHub();
    const a = tab(env.hub, 'A');
    await download(env, { page: a.page, frameId: 'A', name: 'old.pdf' });
    await until(() => a.capture.list().length > 0);

    const waiting = a.capture.waitForNext(Date.now() + 1, 2_000);
    await Bun.sleep(10);
    await download(env, { page: a.page, frameId: 'A', name: 'new.pdf' });
    expect((await waiting).suggestedFilename).toBe('new.pdf');
  });

  it('gives up waiting rather than hanging on a download that never lands', async () => {
    const env = await armedHub();
    const a = tab(env.hub, 'A');
    await expect(a.capture.waitForNext(Date.now(), 100)).rejects.toThrow(/Timed out/);
  });

  it('deletes its unclaimed files when the tab ends, and receives nothing after', async () => {
    const env = await armedHub();
    const a = tab(env.hub, 'A');
    const kept = await download(env, { page: a.page, frameId: 'A' });
    await until(() => a.capture.list().length > 0);

    await a.capture.dispose();
    expect(existsSync(join(env.dir, kept))).toBe(false);
    expect(a.capture.available).toBe(false);

    const late = await download(env, { page: a.page, frameId: 'A' });
    await until(() => !existsSync(join(env.dir, late)));
    expect(a.capture.list()).toEqual([]);
  });
});

describe('safeDownloadName', () => {
  it('keeps a plain name', () => {
    expect(safeDownloadName('2609.00591v2.pdf')).toBe('2609.00591v2.pdf');
  });

  it('cannot climb out of the downloads directory', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('-..-etc-passwd');
    expect(safeDownloadName('/etc/passwd')).toBe('-etc-passwd');
  });

  it('turns separators into dashes rather than deleting them', () => {
    // Stripping would make this "260900591", which reads as a different paper.
    expect(safeDownloadName('2609/00591.pdf')).toBe('2609-00591.pdf');
  });

  it('renames markup to something inert', () => {
    // An .html in the commons is a page an app might later frame, trading this
    // download's origin for YAAR's.
    expect(safeDownloadName('report.html')).toBe('report.html.txt');
    expect(safeDownloadName('logo.svg')).toBe('logo.svg.txt');
  });

  it('always answers with a usable name', () => {
    expect(safeDownloadName('   ')).toMatch(/^download-\d+$/);
    expect(safeDownloadName('...')).toMatch(/^download-\d+$/);
  });
});
