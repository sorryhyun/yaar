// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-media.
 *
 * Media download via the server's optional yt-dlp binary (`yaar://system/ytdlp`).
 * Requires "yaar-media" in app.json `bundles` — the bundle both admits the code
 * and grants the capability at the verb door, like the other gated SDKs
 * (yaar-dev / yaar-web / yaar-ml). No `permissions` entry is needed, and a
 * declared `yaar://system/ytdlp` grants nothing: app manifests never hold
 * `yaar://system/*` URIs.
 *
 * Downloads always land in the storage commons at
 * `yaar://storage/shared/media/{videoId}.{ext}` — the server decides the path,
 * never the caller — so any app can read the result with plain storage calls
 * and no extra grant.
 *
 * Usage:
 *   import { downloadAudio, ytdlpStatus } from '@bundled/yaar-media';
 *   const { available } = await ytdlpStatus();       // yt-dlp installed here?
 *   const job = await downloadAudio(videoUrl);       // starts + polls to completion
 *   const bytes = await yaar.read(job.uri);          // it's in shared/media/
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const y = (window as any).yaar;

const URI = 'yaar://system/ytdlp';

/** yt-dlp availability + the recent job table. Memory-only server-side; poll freely. */
export async function ytdlpStatus() {
  return y.read(URI);
}

/** Metadata + audio-only format list for a YouTube URL. Blocking, no media bytes. */
export async function resolveMedia(url: string) {
  return y.invoke(URI, { action: 'resolve', url });
}

/** Start an audio download job and return its snapshot immediately (fire-and-forget). */
export async function startAudioDownload(url: string) {
  return y.invoke(URI, { action: 'download', url });
}

/** Cancel a running download job. */
export async function cancelDownload(jobId: string) {
  return y.invoke(URI, { action: 'cancel', jobId });
}

/**
 * Download a YouTube URL's best audio track and wait for it to finish.
 * Resolves with the completed job (its `uri` names the file in shared/media/);
 * rejects if the job errors, is cancelled elsewhere, or `timeoutMs` passes —
 * a timeout also cancels the job rather than leaving it running unobserved.
 */
export async function downloadAudio(url: string, opts = {}) {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const started = await startAudioDownload(url);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await ytdlpStatus();
    const job = (status.jobs || []).find((j) => j.id === started.id);
    if (!job) throw new Error(`Download job ${started.id} disappeared from the job table`);
    if (opts.onUpdate) opts.onUpdate(job);
    if (job.stage === 'done') return job;
    if (job.stage === 'error') throw new Error(job.error || 'Download failed');
    if (job.stage === 'cancelled') throw new Error('Download was cancelled');
    if (Date.now() > deadline) {
      await cancelDownload(started.id).catch(() => {});
      throw new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
  }
}
