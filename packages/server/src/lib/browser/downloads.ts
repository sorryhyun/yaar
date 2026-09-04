/**
 * Capturing what the remote Chrome downloads.
 *
 * A download started inside the server-side session — the page's own download button, an
 * `<a download>`, a `Content-Disposition: attachment` navigation — is Chrome's to perform,
 * and for a long time this project assumed that made it unreachable. It does not:
 * `Browser.setDownloadBehavior` names a directory for those files, so the bytes land on
 * the server's own disk under a name Chrome derived from the response.
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
 * ## The directory is the source of truth, not the CDP event
 *
 * `Browser.downloadWillBegin` / `downloadProgress` are listened for, but nothing depends
 * on them, for two measured reasons:
 *
 * - **`behavior: 'allow'` means Chrome picks the name.** The file is
 *   `2609.02367v1.pdf`, not the download's guid — only `allowAndName` uses the guid.
 *   Keying the record off the guid looked for a file that never exists, and the first
 *   version of this module timed out on downloads that had in fact completed perfectly.
 *   Chrome's name is also the *better* name: it comes from the response's
 *   `Content-Disposition`, which is more than the URL knows.
 * - **These are browser-domain events on a page-domain socket.** They are enabled from
 *   the session's page connection, and whether Chrome delivers them back on it is a
 *   detail of its handler routing rather than a promise of the protocol.
 *
 * What Chrome does promise is the file: an in-progress download is `name.crdownload` and
 * is *renamed* to `name` when it completes. So a non-`.crdownload` file appearing in the
 * directory is a completed download, and `fs.watch` turns that into an event with no
 * polling. The CDP events, when they do arrive, only enrich a record with the source URL
 * — which the filesystem cannot know.
 *
 * Files stay in the capture directory until something claims one with {@link
 * DownloadCapture.take}. A completed download nobody claimed is dropped with the
 * directory when the session ends.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClient } from './cdp.js';

/** A download Chrome finished writing, still sitting in the capture directory. */
export interface CapturedDownload {
  /**
   * How this download is claimed. The file's name inside the capture directory, which
   * Chrome guarantees unique there — a second `paper.pdf` becomes `paper (1).pdf`.
   */
  id: string;
  /** Where the bytes came from, when a `downloadWillBegin` event named it. Else `''`. */
  url: string;
  /** The name Chrome chose, from `Content-Disposition` or the URL. Same as {@link id}. */
  suggestedFilename: string;
  bytes: number;
  /** Absolute path of the captured file. Valid until {@link DownloadCapture.take}. */
  file: string;
  /** Epoch ms at completion. */
  at: number;
}

/** How many finished-but-unclaimed downloads are remembered per session. */
const MAX_KEPT = 20;

/** Chrome's in-progress suffix. A file wearing it is not finished. */
const PARTIAL_SUFFIX = '.crdownload';

/** Size-stability sampling, for the rare download written without a partial file. */
const SETTLE_INTERVAL_MS = 150;
const SETTLE_ATTEMPTS = 60;

interface Waiter {
  resolve: (d: CapturedDownload) => void;
  /** Only a download that completed at or after this timestamp settles this waiter. */
  since: number;
}

export class DownloadCapture {
  private dir: string | null = null;
  private armed = false;
  private watcher: FSWatcher | null = null;
  /** Names already turned into a record, so two watch events cost one record. */
  private seen = new Set<string>();
  /** `downloadWillBegin` metadata, keyed by the name Chrome said it would use. */
  private announced = new Map<string, string>();
  private finished: CapturedDownload[] = [];
  private waiters: Waiter[] = [];

  constructor(private readonly onComplete: (d: CapturedDownload) => void) {}

  /** Whether Chrome accepted the download-behavior command on this socket. */
  get available(): boolean {
    return this.armed;
  }

  /**
   * Point a freshly-connected CDP socket's downloads at this session's directory.
   *
   * Called from `initTarget`, so it runs for a new tab and again after a crash-restart
   * reattaches to a new target — the behavior is a property of the *connection*, and a
   * reattached session that skipped this would silently stop capturing.
   *
   * `Browser.setDownloadBehavior` is a browser-domain command, but Chrome accepts it on a
   * page connection; the deprecated `Page.` form is tried after it. A refusal is
   * recorded, not thrown: every other thing a browser session does still works without
   * downloads, and `available` is what the action layer reports.
   */
  async attach(cdp: CDPClient): Promise<void> {
    const dir = await this.ensureDir();

    // Enrichment only — see the module header. A record is built from the file.
    const onWillBegin = (params: unknown) => {
      const p = params as { url?: string; suggestedFilename?: string };
      if (p?.suggestedFilename && p.url) this.announced.set(p.suggestedFilename, p.url);
    };
    cdp.on('Browser.downloadWillBegin', onWillBegin);
    cdp.on('Page.downloadWillBegin', onWillBegin);

    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
        eventsEnabled: true,
      });
      this.armed = true;
    } catch {
      try {
        await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
        this.armed = true;
      } catch (err) {
        this.armed = false;
        console.warn('[browser] downloads unavailable — Chrome refused setDownloadBehavior:', err);
        return;
      }
    }
    this.startWatching(dir);
  }

  private async ensureDir(): Promise<string> {
    if (!this.dir) this.dir = await mkdtemp(join(tmpdir(), 'yaar-browser-dl-'));
    return this.dir;
  }

  /**
   * Watch the capture directory for completed downloads.
   *
   * One watcher for the life of the session, not one per connection: a reattach hands us
   * a new socket but the same directory, and a second watcher would report every file
   * twice. The initial `sweep` covers whatever landed before the watcher was installed.
   */
  private startWatching(dir: string): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(dir, (_event, name) => {
        if (typeof name === 'string') void this.notice(name);
      });
      this.watcher.on('error', () => {
        // A watcher that dies leaves `waitForNext`'s own sweep as the fallback.
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
    void this.sweep();
  }

  /** Turn whatever is already in the directory into records. */
  private async sweep(): Promise<void> {
    if (!this.dir) return;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) await this.notice(name);
  }

  /**
   * Consider one directory entry.
   *
   * A `.crdownload` is Chrome still writing; the rename to the final name is the
   * completion signal and arrives as its own watch event. The size-stability loop after
   * it is insurance for the case where a file appears under its final name from the
   * start — cheap, because in the common case the very first sample is already stable.
   *
   * The name is marked seen *before* the awaits, so the several watch events one rename
   * produces cost one record rather than several.
   */
  private async notice(name: string): Promise<void> {
    if (!this.dir || !name || name.endsWith(PARTIAL_SUFFIX) || this.seen.has(name)) return;
    this.seen.add(name);

    const file = join(this.dir, name);
    let bytes = -1;
    for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        // Gone again — a temp file Chrome renamed away. Not a download.
        this.seen.delete(name);
        return;
      }
      if (size > 0 && size === bytes) break;
      bytes = size;
      await Bun.sleep(SETTLE_INTERVAL_MS);
    }
    if (bytes <= 0) {
      this.seen.delete(name);
      return;
    }

    const entry: CapturedDownload = {
      id: name,
      url: this.announced.get(name) ?? '',
      suggestedFilename: name,
      bytes,
      file,
      at: Date.now(),
    };
    this.announced.delete(name);
    this.record(entry);
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
   *
   * An evicted name stays in `seen`. Its file is being removed, and re-noticing a name
   * whose file is on its way out would file the same download twice.
   */
  private record(entry: CapturedDownload): void {
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
   *
   * A sweep runs alongside the wait, so a lost watcher — or a platform where `fs.watch`
   * reports nothing for a rename — degrades to a poll instead of to a timeout.
   */
  waitForNext(since: number, timeoutMs: number): Promise<CapturedDownload> {
    // Spliced out, not read: a waiter *claims* the download, so it must not also stay
    // listed for the announcement path to hand out a second time.
    const readyAt = this.finished.findIndex((d) => d.at >= since);
    if (readyAt !== -1) return Promise.resolve(this.finished.splice(readyAt, 1)[0]);

    return new Promise((resolve, reject) => {
      let done = false;
      const waiter: Waiter = {
        since,
        resolve: (d) => {
          done = true;
          clearInterval(poll);
          clearTimeout(timer);
          resolve(d);
        },
      };
      const poll = setInterval(() => {
        if (!done) void this.sweep();
      }, 1000);
      const timer = setTimeout(() => {
        done = true;
        clearInterval(poll);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('Timed out waiting for the download to finish.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Drop the capture directory and everything unclaimed in it. */
  async dispose(): Promise<void> {
    const dir = this.dir;
    this.dir = null;
    this.watcher?.close();
    this.watcher = null;
    this.finished = [];
    this.seen.clear();
    this.announced.clear();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
