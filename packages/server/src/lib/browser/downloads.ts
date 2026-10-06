/**
 * Capturing what the remote Chrome downloads.
 *
 * A download started inside the server-side session — the page's own download button, an
 * `<a download>`, a `Content-Disposition: attachment` navigation — is Chrome's to perform,
 * and for a long time this project assumed that made it unreachable. It does not:
 * `Browser.setDownloadBehavior` names a directory for those files, so the bytes land on
 * the server's own disk.
 *
 * Two things follow that a re-fetch through `yaar://http` could never have:
 *
 * - **The transfer is the tab's.** It carries the tab's cookies, its `Authorization`
 *   headers, its TLS session. A file behind a login downloads here exactly as it would
 *   for a human sitting in front of that browser.
 * - **The bytes never traverse CDP or an app.** Chrome writes the file; this module only
 *   learns where. Nothing is base64-encoded, chunked, or held in an iframe's heap, so
 *   size is bounded by the disk rather than by a proxy's response cap.
 *
 * ## One directory per Chrome, set once, from the browser socket
 *
 * The download behavior is not a property of a tab. Chrome keeps one per browser context,
 * and every YAAR tab shares the default context (that is how they share the persisted
 * profile's cookies). This module used to have each tab point it at that tab's own
 * directory from the tab's own socket, which measured as two failures:
 *
 * - **The last tab to connect took every download.** A tab attached after the one the
 *   user was downloading in — a reader app's cookie tab, a revive, a popup — moved the
 *   directory, so the file landed where nobody was watching for it and was deleted with
 *   that other tab.
 * - **Any tab disconnecting reset it.** Chrome restores the default behavior when the
 *   socket that set it detaches, so after an idle sweep the next download went to the
 *   machine's `~/Downloads` and was captured by no one.
 *
 * So {@link DownloadHub} sets it exactly once, on the provider's browser-level socket —
 * the one that lives as long as Chrome does — and owns the one directory it names.
 *
 * ## Attribution by guid
 *
 * With every tab writing into one directory, a file says nothing about whose it is. The
 * behavior is `allowAndName`, so Chrome names each file by its download guid, and the
 * events carry that guid end to end:
 *
 * - `Page.downloadWillBegin` arrives on the *downloading tab's own* socket — for a
 *   download from any of its frames — and is what assigns the guid to a
 *   {@link DownloadCapture}. The tab's main frame id (which is its target id) is the
 *   fallback when that event is missed.
 * - `Browser.downloadWillBegin` on the browser socket brings the URL and the name Chrome
 *   derived (from `Content-Disposition`, a `download` attribute, or the URL).
 * - `Browser.downloadProgress` with `state: 'completed'` is the completion signal. On the
 *   browser socket these events are what `eventsEnabled` promises, unlike the page-socket
 *   routing the previous design could not rely on.
 *
 * Files stay in the directory until something claims one with {@link
 * DownloadCapture.take}. A completed download nobody claimed is deleted when its tab
 * ends, and one no tab can be found for is deleted at once.
 */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPClient } from './cdp.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('browser');

/** A download Chrome finished writing, still sitting in the capture directory. */
export interface CapturedDownload {
  /** How this download is claimed: Chrome's download guid, which is also the file's name. */
  id: string;
  /** Where the bytes came from, when `downloadWillBegin` named it. Else `''`. */
  url: string;
  /** The name Chrome derived, from `Content-Disposition`, a `download` attribute or the URL. */
  suggestedFilename: string;
  bytes: number;
  /** Absolute path of the captured file. Valid until {@link DownloadCapture.take}. */
  file: string;
  /** Epoch ms at completion. */
  at: number;
}

/** How many finished-but-unclaimed downloads are remembered per session. */
const MAX_KEPT = 20;

/**
 * How long a completed download waits for its tab to claim it before being treated as
 * nobody's. The tab's `Page.downloadWillBegin` precedes the transfer, so in practice it is
 * already there; this only covers the two sockets' messages crossing.
 */
const OWNER_GRACE_MS = 250;

interface Waiter {
  resolve: (d: CapturedDownload) => void;
  /** Only a download that completed at or after this timestamp settles this waiter. */
  since: number;
}

interface Begun {
  url: string;
  suggestedFilename: string;
  frameId: string;
}

/**
 * The one download directory of one Chrome, and the router from its downloads to the
 * tabs they came from. One per provider; see the module header for why not one per tab.
 */
export class DownloadHub {
  private dir: Promise<string> | null = null;
  /** The browser socket the behavior is set on. Null until armed, and after it closes. */
  private client: CDPClient | null = null;
  private readonly captures = new Set<DownloadCapture>();
  /** guid → the tab whose socket announced it. */
  private readonly owners = new Map<string, DownloadCapture>();
  /** guid → what the browser socket said about it when it began. */
  private readonly begun = new Map<string, Begun>();

  /**
   * `makeDir` is asked once, lazily, for the directory to hand Chrome. It is the
   * provider's to decide (a persisted state dir, or a scratch one for an ephemeral
   * profile) and its to empty: captures live in memory, so a file an earlier run left
   * there is nobody's to claim.
   */
  constructor(
    private readonly makeDir: () => Promise<string>,
    private readonly ownerGraceMs = OWNER_GRACE_MS,
  ) {}

  /** Whether Chrome accepted the download behavior on the live browser socket. */
  get available(): boolean {
    return this.client !== null;
  }

  /**
   * Point this Chrome's downloads at the hub's directory, from its browser-level socket.
   *
   * Called for every new browser socket — a relaunched Chrome is a new one and starts
   * from its own default behavior. A refusal is recorded, not thrown: every other thing a
   * browser session does still works without downloads, and `available` is what the
   * action layer reports.
   */
  async arm(client: CDPClient): Promise<void> {
    let dir: string;
    try {
      dir = await this.ensureDir();
    } catch (err) {
      log.warn('downloads unavailable — no capture directory', { err });
      return;
    }
    client.on('Browser.downloadWillBegin', (params) => this.onWillBegin(params));
    client.on('Browser.downloadProgress', (params) => this.onProgress(params));
    try {
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dir,
        eventsEnabled: true,
      });
      this.client = client;
    } catch (err) {
      log.warn('downloads unavailable — Chrome refused setDownloadBehavior', { err });
    }
  }

  /** The browser socket went away; downloads are not captured until the next {@link arm}. */
  disarm(client: CDPClient): void {
    if (this.client === client) this.client = null;
  }

  register(capture: DownloadCapture): void {
    this.captures.add(capture);
  }

  unregister(capture: DownloadCapture): void {
    this.captures.delete(capture);
    for (const [guid, owner] of this.owners) if (owner === capture) this.owners.delete(guid);
  }

  /** A tab's own socket said this download is its. */
  claim(guid: string, capture: DownloadCapture): void {
    if (this.captures.has(capture)) this.owners.set(guid, capture);
  }

  private ensureDir(): Promise<string> {
    if (!this.dir) {
      this.dir = this.makeDir();
      // A failed attempt is not cached: the next arm gets a fresh one.
      this.dir.catch(() => {
        this.dir = null;
      });
    }
    return this.dir;
  }

  private onWillBegin(params: unknown): void {
    const p = params as {
      guid?: string;
      url?: string;
      suggestedFilename?: string;
      frameId?: string;
    };
    if (!p?.guid) return;
    this.begun.set(p.guid, {
      url: p.url ?? '',
      suggestedFilename: p.suggestedFilename ?? '',
      frameId: p.frameId ?? '',
    });
  }

  private onProgress(params: unknown): void {
    const p = params as { guid?: string; state?: string; filePath?: string };
    if (!p?.guid) return;
    if (p.state === 'completed') void this.complete(p.guid, p.filePath);
    else if (p.state === 'canceled') void this.discard(p.guid, p.filePath);
  }

  private ownerOf(guid: string): DownloadCapture | undefined {
    const owner = this.owners.get(guid);
    if (owner) return owner;
    const frameId = this.begun.get(guid)?.frameId;
    if (!frameId) return undefined;
    for (const capture of this.captures) if (capture.ownsFrame(frameId)) return capture;
    return undefined;
  }

  private async complete(guid: string, filePath?: string): Promise<void> {
    const file = filePath || join(await this.ensureDir(), guid);
    let owner = this.ownerOf(guid);
    if (!owner) {
      await Bun.sleep(this.ownerGraceMs);
      owner = this.ownerOf(guid);
    }
    const begun = this.begun.get(guid);
    this.begun.delete(guid);
    this.owners.delete(guid);

    if (!owner) {
      log.warn('download from no tab YAAR is attached to — discarded', {
        url: begun?.url,
        suggestedFilename: begun?.suggestedFilename,
      });
      await rm(file, { force: true }).catch(() => {});
      return;
    }

    let bytes: number;
    try {
      bytes = (await stat(file)).size;
    } catch {
      log.warn('completed download is not on disk', { guid, file });
      return;
    }
    owner.record({
      id: guid,
      url: begun?.url ?? '',
      suggestedFilename: begun?.suggestedFilename || guid,
      bytes,
      file,
      at: Date.now(),
    });
  }

  private async discard(guid: string, filePath?: string): Promise<void> {
    this.begun.delete(guid);
    this.owners.delete(guid);
    const file = filePath || join(await this.ensureDir(), guid);
    await rm(file, { force: true }).catch(() => {});
  }
}

/**
 * One tab's downloads: the ones the {@link DownloadHub} routed to it that nobody has
 * claimed yet, and whoever is waiting for the next one.
 */
export class DownloadCapture {
  /** The tab's main frame, which is its target id — the hub's fallback for attribution. */
  private mainFrameId: string | null = null;
  private finished: CapturedDownload[] = [];
  private waiters: Waiter[] = [];
  private disposed = false;

  constructor(
    private readonly hub: DownloadHub | null,
    private readonly onComplete: (d: CapturedDownload) => void,
  ) {
    hub?.register(this);
  }

  /** Whether downloads are being captured in this tab's browser right now. */
  get available(): boolean {
    return !this.disposed && (this.hub?.available ?? false);
  }

  /**
   * Listen on a freshly-connected socket of this tab for the downloads it starts.
   *
   * Called from `initTarget`, so it runs for a new tab and again after a crash-restart
   * reattaches to a new target. It sets no behavior — that is the hub's, once per
   * Chrome. Needs `Page.enable`, which `initTarget` has already sent.
   */
  attach(cdp: CDPClient): void {
    cdp.on('Page.downloadWillBegin', (params: unknown) => {
      const guid = (params as { guid?: string })?.guid;
      if (guid) this.hub?.claim(guid, this);
    });
  }

  /** The tab's top frame navigated; the session reports it from its own listener. */
  noteMainFrame(frameId: string): void {
    this.mainFrameId = frameId;
  }

  ownsFrame(frameId: string): boolean {
    return frameId === this.mainFrameId;
  }

  /**
   * File a completed download — to its waiter, or to the unclaimed list.
   *
   * A download someone is waiting for is **theirs**: it is handed over and neither listed
   * nor announced. Doing both would double-save the same file — `download { url }`
   * resolves its wait and stores the capture, while the announcement sends the app back
   * to claim an id the action is in the middle of taking.
   *
   * Only downloads nobody asked for reach `onComplete`, which is exactly the set the
   * announcement exists for: the ones Chrome performed on the page's initiative.
   */
  record(entry: CapturedDownload): void {
    if (this.disposed) {
      void rm(entry.file, { force: true }).catch(() => {});
      return;
    }
    const waiter = this.waiters.find((w) => entry.at >= w.since);
    if (waiter) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(entry);
      return;
    }

    this.finished.unshift(entry);
    if (this.finished.length > MAX_KEPT) {
      // Drop the oldest unclaimed capture's file with its record, so a tab that
      // downloads all day cannot fill the disk behind a caller that never claims.
      for (const stale of this.finished.splice(MAX_KEPT)) void rm(stale.file, { force: true });
    }

    this.onComplete(entry);
  }

  /** Finished downloads nobody has claimed yet, newest first. */
  list(): CapturedDownload[] {
    return [...this.finished];
  }

  /**
   * Claim a captured download. The caller owns the file from here — it is no longer
   * listed, and nothing else will delete it.
   */
  take(id: string): CapturedDownload | undefined {
    const i = this.finished.findIndex((d) => d.id === id);
    if (i === -1) return undefined;
    return this.finished.splice(i, 1)[0];
  }

  /**
   * Wait for the next download to complete, ignoring any that finished before `since`.
   *
   * The timestamp is what makes this usable after a click: a download already sitting in
   * the list is not the one the caller just asked for, and resolving with it would hand
   * back the previous file.
   */
  waitForNext(since: number, timeoutMs: number): Promise<CapturedDownload> {
    // Spliced out, not read: a waiter *claims* the download, so it must not also stay
    // listed for the announcement path to hand out a second time.
    const readyAt = this.finished.findIndex((d) => d.at >= since);
    if (readyAt !== -1) return Promise.resolve(this.finished.splice(readyAt, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        since,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('Timed out waiting for the download to finish.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Stop receiving downloads and delete everything unclaimed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.hub?.unregister(this);
    const files = this.finished.map((d) => d.file);
    this.finished = [];
    await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => {})));
  }
}
