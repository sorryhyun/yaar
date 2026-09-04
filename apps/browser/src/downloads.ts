/**
 * Saving a file out of the remote browser.
 *
 * All of this is one call now. `web.download()` asks the *tab* to perform the transfer,
 * which is what makes the feature work at all:
 *
 * - it carries the tab's cookies, so a file behind a login saves here exactly as it
 *   would for a human in front of that browser;
 * - the bytes go from Chrome straight to the server's disk, so nothing is chunked,
 *   base64-encoded, or held in this iframe's heap;
 * - Chrome's own download machinery does it, so the page's download button — including
 *   the one in its built-in PDF viewer — is captured too, and arrives here on the SSE
 *   stream as a `download` frame carrying an `id` (see `sse.ts`).
 *
 * An earlier version of this file re-fetched the URL through YAAR's HTTP proxy and had
 * to hand-roll `Range` assembly to get past that proxy's 10MB cap, while still failing
 * on anything behind a login. None of that was a fact about downloads; it was a fact
 * about fetching from the wrong client. Do not reintroduce it.
 *
 * Imports `store.ts` and nothing else of this app's, which is what keeps it clear of the
 * `sse -> actions` and `session -> sse` edges. Keep it that way — `sse.ts`, `view.ts`
 * and `protocol.ts` all reach into it, so an import back would close a cycle. In
 * particular `browserOpts()` lives in `session.ts` and is therefore out of reach: the
 * active id comes from the store, and a caller that already holds one passes it.
 */
import { createSignal } from '@bundled/solid-js';
import { errMsg, formatBytes, showToast, storage, windows } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { activeBrowserId } from './store';

/** Captures kept for the `downloads` state key. */
const MAX_RECENT = 20;

/** How long a finished status sits in the toolbar before it clears. */
const STATUS_LINGER_MS = 6000;

export interface DownloadEntry {
  /** File name inside `shared/browser/downloads/`. */
  name: string;
  /** The URL the bytes came from. */
  url: string;
  /** Root-relative storage path, e.g. `shared/browser/downloads/2609.00591.pdf`. */
  path: string;
  /** The same file as a `yaar://storage/...` URI. */
  uri: string;
  bytes: number;
  /** Epoch ms. */
  at: number;
}

const [recentDownloads, setRecentDownloads] = createSignal<DownloadEntry[]>([]);
const [downloadStatus, setDownloadStatus] = createSignal('');
const [downloading, setDownloading] = createSignal(false);

export { recentDownloads, downloadStatus, downloading };

let statusTimer: ReturnType<typeof setTimeout> | null = null;

/** Show a line in the toolbar; a settled one clears itself so the chrome does not accrete. */
function setStatus(text: string, settled: boolean): void {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  setDownloadStatus(text);
  if (settled && text) {
    statusTimer = setTimeout(() => setDownloadStatus(''), STATUS_LINGER_MS);
  }
}

function remember(entry: DownloadEntry): void {
  setRecentDownloads((prev) =>
    [entry, ...prev.filter((e) => e.path !== entry.path)].slice(0, MAX_RECENT),
  );
}

/** A stored PDF renders natively in a window of its own; nothing else has a viewer. */
function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * Show a saved file in a window. The browser renders a PDF natively, which is the whole
 * point — `apps/storage` frames the same URL for its own PDF preview.
 *
 * `storage.url()` on the path the *server* returned, rather than `sharedStorage.url()`
 * on a name: this app never writes through the SDK, so `sharedStorage` has never learned
 * its real commons directory and would spell the path `shared/self/…`. The URL form is
 * what carries this app's iframe token, which a bare `/api/storage/…` path does not — a
 * window opened without it resolves as the host and cannot read the file.
 *
 * Not verifiable from a Dev Tools preview: `openUrl` is a silent no-op for the preview
 * principal, which cannot open windows at all. Exercise it in the installed app.
 */
export function openDownload(entry: DownloadEntry): void {
  windows.openUrl(storage.url(entry.path), { title: entry.name });
}

/**
 * The one path every download takes: call the verb, record it, show it.
 *
 * A PDF opens in its own window, which is the point of the exercise. Anything else is
 * announced rather than opened — the desktop has no renderer for a .zip, and a window
 * that fails to display one is a worse answer than a line saying where it went.
 */
async function run(
  params: { url?: string; id?: string; filename?: string },
  browserId?: string,
): Promise<DownloadEntry> {
  setDownloading(true);
  setStatus('Downloading…', false);
  try {
    // The envelope is flattened rather than narrowed: this project compiles without
    // strict null checks, so `if (res.ok)` would not narrow the union (see AGENTS.md).
    const res = (await web.download({ ...params, browserId: browserId || activeBrowserId() })) as {
      ok?: boolean;
      error?: string;
      data?: DownloadEntry;
    };
    if (!res.ok || !res.data) throw new Error(res.error || 'The download was refused.');

    const entry = res.data;
    remember(entry);
    setStatus(`Saved ${entry.name} (${formatBytes(entry.bytes)})`, true);
    if (isPdfPath(entry.name)) openDownload(entry);
    else showToast(`Saved ${entry.name} to ${entry.path}`, 'success');
    return entry;
  } catch (e) {
    setStatus(`Download failed: ${errMsg(e)}`, true);
    throw e;
  } finally {
    setDownloading(false);
  }
}

/** Save a URL (default: whatever the tab is showing). Used by the `download` command. */
export async function captureUrl(
  opts: { url?: string; filename?: string; browserId?: string } = {},
): Promise<DownloadEntry> {
  return run({ url: opts.url, filename: opts.filename }, opts.browserId);
}

/**
 * Claim a download Chrome performed on its own.
 *
 * This is the payoff of doing the capture server-side: the user presses the download
 * arrow in the remote Chrome's PDF viewer — a control this app cannot reach and never
 * could — and the file still arrives, because Chrome wrote it and the SSE frame said so.
 */
export function claimDownload(id: string, suggestedFilename: string, browserId: string): void {
  setStatus(`Saving ${suggestedFilename || id}…`, false);
  void run({ id }, browserId).catch(() => {
    // `run` has already put the reason in the toolbar status.
  });
}

/** The toolbar's download button: save whatever is on screen. */
export function handleDownload(currentUrl: string): void {
  if (!currentUrl || currentUrl === 'about:blank') {
    setStatus('Nothing to download.', true);
    return;
  }
  void captureUrl().catch(() => {
    // `run` has already put the reason in the toolbar status.
  });
}
