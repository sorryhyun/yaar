/**
 * Download capture — the half of `web.download()` that does not need a browser.
 *
 * Everything here writes real files into the capture directory, because the directory
 * *is* the mechanism: Chrome writes `name.crdownload` and renames it to `name` on
 * completion, and that rename is what this module treats as the completion signal. The
 * CDP events only enrich a record with the source URL, so the fake socket below is
 * barely more than a way to learn where the directory is.
 *
 * The parts that genuinely need Chrome (`setDownloadBehavior` being accepted, the
 * injected `<a download>` click) are exercised by driving the app, not here.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DownloadCapture, type CapturedDownload } from '../lib/browser/downloads.js';
import type { CDPClient } from '../lib/browser/cdp.js';
import { safeDownloadName } from '../features/browser/actions.js';

/** A CDP socket that records handlers and reports where downloads were pointed. */
function fakeCdp() {
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  let downloadPath = '';
  const cdp = {
    on(event: string, handler: (params: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async send(method: string, params?: Record<string, unknown>) {
      if (method === 'Browser.setDownloadBehavior') {
        downloadPath = String(params?.downloadPath ?? '');
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const emit = (event: string, params: unknown) => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  return { cdp: cdp as unknown as CDPClient, emit, dir: () => downloadPath };
}

/** What Chrome does: write the partial file, then rename it to the final name. */
async function landFile(dir: string, name: string, bytes: number): Promise<void> {
  const partial = join(dir, `${name}.crdownload`);
  await writeFile(partial, Buffer.alloc(bytes, 1));
  await rename(partial, join(dir, name));
}

let live: DownloadCapture[] = [];
function capture(onComplete: (d: CapturedDownload) => void = () => {}): DownloadCapture {
  const c = new DownloadCapture(onComplete);
  live.push(c);
  return c;
}

/** Give the watcher and the settle loop room to run. */
const settle = () => Bun.sleep(600);

afterEach(async () => {
  for (const c of live) await c.dispose();
  live = [];
});

describe('DownloadCapture', () => {
  it('treats the rename out of .crdownload as the completed download', async () => {
    const seen: CapturedDownload[] = [];
    const cap = capture((d) => seen.push(d));
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);
    expect(cap.available).toBe(true);

    await landFile(dir(), '2609.02367v1.pdf', 2048);
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      // Chrome's own name, not a guid: `behavior: 'allow'` leaves naming to Chrome, and
      // its name comes from Content-Disposition, which the URL does not know.
      id: '2609.02367v1.pdf',
      suggestedFilename: '2609.02367v1.pdf',
      // Read off the disk rather than off an event.
      bytes: 2048,
    });
    expect(cap.list().map((d) => d.id)).toEqual(['2609.02367v1.pdf']);
  });

  it('ignores a download still in progress', async () => {
    const seen: CapturedDownload[] = [];
    const cap = capture((d) => seen.push(d));
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);

    await writeFile(join(dir(), 'big.pdf.crdownload'), Buffer.alloc(4096, 1));
    await settle();
    expect(seen).toEqual([]);

    await rename(join(dir(), 'big.pdf.crdownload'), join(dir(), 'big.pdf'));
    await settle();
    expect(seen.map((d) => d.id)).toEqual(['big.pdf']);
  });

  it('takes the source URL from downloadWillBegin when it arrives', async () => {
    const seen: CapturedDownload[] = [];
    const cap = capture((d) => seen.push(d));
    const { cdp, emit, dir } = fakeCdp();
    await cap.attach(cdp);

    emit('Browser.downloadWillBegin', {
      guid: 'ignored',
      url: 'https://arxiv.test/pdf/2609.02367v1',
      suggestedFilename: 'paper.pdf',
    });
    await landFile(dir(), 'paper.pdf', 16);
    await settle();
    expect(seen[0]?.url).toBe('https://arxiv.test/pdf/2609.02367v1');
  });

  it('still captures a download no event announced', async () => {
    // The whole point of watching the directory: `Browser.download*` are browser-domain
    // events enabled from a page-domain socket, and nothing may depend on their arrival.
    const seen: CapturedDownload[] = [];
    const cap = capture((d) => seen.push(d));
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);
    await landFile(dir(), 'silent.zip', 32);
    await settle();
    expect(seen.map((d) => d.id)).toEqual(['silent.zip']);
    expect(seen[0]?.url).toBe('');
  });

  it('picks up whatever was already in the directory', async () => {
    const cap = capture();
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);
    // Straight into the directory, no watch event of our making — the sweep finds it.
    await writeFile(join(dir(), 'earlier.pdf'), Buffer.alloc(64, 1));
    await settle();
    expect(cap.list().map((d) => d.id)).toContain('earlier.pdf');
  });

  it('falls back to the deprecated page-level command, and records a refusal', async () => {
    const pageOnly = {
      on() {},
      async send(method: string) {
        if (method === 'Page.setDownloadBehavior') return {};
        throw new Error('Browser domain not available');
      },
    } as unknown as CDPClient;
    const cap = capture();
    await cap.attach(pageOnly);
    expect(cap.available).toBe(true);

    const refuses = {
      on() {},
      async send() {
        throw new Error('nope');
      },
    } as unknown as CDPClient;
    const dead = capture();
    await dead.attach(refuses);
    expect(dead.available).toBe(false);
  });

  it('claims an id exactly once', async () => {
    const cap = capture();
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);
    await landFile(dir(), 'a.zip', 8);
    await settle();

    expect(cap.take('a.zip')?.bytes).toBe(8);
    expect(cap.take('a.zip')).toBeUndefined();
    expect(cap.list()).toEqual([]);
  });

  it('hands a waited-for download to its waiter alone', async () => {
    // Both at once would double-save it: the action stores the capture it was handed
    // while the announcement sends the app back to claim the very same id.
    const announced: CapturedDownload[] = [];
    const cap = capture((d) => announced.push(d));
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);

    const waiting = cap.waitForNext(Date.now(), 5000);
    await landFile(dir(), 'claimed.pdf', 12);

    expect((await waiting).id).toBe('claimed.pdf');
    expect(announced).toEqual([]);
    expect(cap.list()).toEqual([]);
    expect(cap.take('claimed.pdf')).toBeUndefined();
  });

  it('announces a download nobody was waiting for', async () => {
    const announced: CapturedDownload[] = [];
    const cap = capture((d) => announced.push(d));
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);

    await landFile(dir(), 'page-pressed-it.pdf', 12);
    await settle();
    expect(announced.map((d) => d.id)).toEqual(['page-pressed-it.pdf']);
    expect(cap.list().map((d) => d.id)).toEqual(['page-pressed-it.pdf']);
  });

  it('settles a waiter only with a download that finished after it started waiting', async () => {
    const cap = capture();
    const { cdp, dir } = fakeCdp();
    await cap.attach(cdp);

    // The previous download, not the one being asked for.
    await landFile(dir(), 'old.pdf', 4);
    await settle();

    const waiting = cap.waitForNext(Date.now() + 1, 5000);
    await Bun.sleep(20);
    await landFile(dir(), 'new.pdf', 4);

    expect((await waiting).id).toBe('new.pdf');
  });

  it('gives up waiting rather than hanging on a download that never lands', async () => {
    const cap = capture();
    const { cdp } = fakeCdp();
    await cap.attach(cdp);
    await expect(cap.waitForNext(Date.now(), 200)).rejects.toThrow(/Timed out/);
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
