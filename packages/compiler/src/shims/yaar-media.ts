// @ts-nocheck — This file runs in browser iframes, not the server.
/**
 * Gated SDK for @bundled/yaar-media.
 *
 * Media streaming and download:
 * - `mediaUrl()` — a same-origin URL for `<video src>` / `<audio src>` / `fetch()` that
 *   streams a remote file through `/api/media-proxy` with Range passthrough. Unlike a
 *   plain cross-origin `fetch`, which the prelude routes through `/api/fetch` (buffered,
 *   base64, capped at 10MB), nothing is held in memory on either side.
 * - Audio download via the server's optional yt-dlp binary (`yaar://system/ytdlp`).
 *
 * Requires "yaar-media" in app.json `bundles` — the bundle both admits the code
 * and grants the capability at the verb door, like the other gated SDKs
 * (yaar-dev / yaar-web / yaar-ml). No `permissions` entry is needed, and a
 * declared `yaar://system/ytdlp` grants nothing: app manifests never hold
 * `yaar://system/*` URIs.
 *
 * - Camera / microphone capture recorded straight into storage: `openCamera()`,
 *   `capturePhoto()`, `recordToStorage()`. Recording hands MediaRecorder's chunks to the
 *   server as they arrive (`storage.append`), so a recording is never held whole in the
 *   frame's memory and is not bound by the 50MB upload cap.
 *
 * Downloads always land in the storage commons at
 * `yaar://storage/shared/media/{videoId}.{ext}` — the server decides the path,
 * never the caller — so any app can read the result with plain storage calls
 * and no extra grant.
 *
 * Usage:
 *   import { mediaUrl, downloadAudio, ytdlpStatus } from '@bundled/yaar-media';
 *   video.src = mediaUrl(fileUrl, { referer: 'https://example.com/' });

 *   const { available } = await ytdlpStatus();       // yt-dlp installed here?
 *   const job = await downloadAudio(videoUrl);       // starts + polls to completion
 *   const bytes = await yaar.read(job.uri);          // it's in shared/media/
 *
 *   const stream = await openCamera({ facingMode: 'environment' });
 *   preview.srcObject = stream;
 *   const rec = recordToStorage(stream, 'recordings/clip');  // extension added from the codec
 *   const { path, bytes } = await rec.stop();                // 'recordings/clip.webm'
 */

const y = (window as any).yaar;

const URI = 'yaar://system/ytdlp';

/**
 * A same-origin URL that streams `url` through the server, for a media element to load.
 *
 * A media element cannot set headers, so both of YAAR's credentials ride in the query:
 * the remote token (`token`, REMOTE mode) and the iframe token (`__yaar_token`, which
 * carries the `yaar-media` bundle declaration). `referer` is forwarded upstream as the
 * `Referer` header, for CDNs that refuse hotlinked requests without one.
 *
 * The response streams, so it carries no `Content-Length`. When the upstream declared an
 * unencoded length, it arrives as `X-Content-Length`: compare it with the bytes read to
 * tell a complete body from a truncated one. Absent means the length is unknown.
 */
export function mediaUrl(url: string, opts: { referer?: string } = {}): string {
  const out = new URL('/api/media-proxy', location.href);
  out.searchParams.set('url', url);
  if (opts.referer) out.searchParams.set('referer', opts.referer);
  try {
    const remoteToken = new URLSearchParams(location.search).get('token');
    if (remoteToken) out.searchParams.set('token', remoteToken);
  } catch {
    // No readable search — the iframe token below may still apply.
  }
  const iframeToken = window.__YAAR_TOKEN__;
  if (iframeToken) out.searchParams.set('__yaar_token', iframeToken);
  return out.href;
}

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

// ── Capture ──────────────────────────────────────────────────────

/**
 * getUserMedia's failures, in words a user can act on. The DOMException names are the
 * contract; the messages browsers attach to them vary and mostly say "Permission denied".
 */
function captureError(err, what) {
  const name = err && err.name;
  let message;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    message = `${what} permission was denied. Allow it in the browser (or Android app) settings and try again.`;
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    message = `No ${what.toLowerCase()} matching the request was found on this device.`;
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    message = `The ${what.toLowerCase()} is in use by another app, or the system refused to start it.`;
  } else {
    message = `Could not open the ${what.toLowerCase()}: ${(err && err.message) || err}`;
  }
  const out = new Error(message);
  out.name = name || 'Error';
  out.cause = err;
  return out;
}

/**
 * Open the camera (and, with `audio`, the microphone) as a MediaStream.
 *
 * `video` / `audio` take `true`, `false` or full MediaTrackConstraints; `facingMode` is
 * the shorthand for the one constraint a phone app always wants ('environment' is the
 * back camera). Stop the stream with `stopStream` when done — the camera light stays on
 * until every track is stopped.
 */
export async function openCamera(opts = {}) {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') {
    throw new Error(
      'Camera capture is unavailable here: the page is not a secure context (open YAAR on localhost or https).',
    );
  }
  let video = opts.video === undefined ? true : opts.video;
  if (video && opts.facingMode) {
    video = { ...(typeof video === 'object' ? video : {}), facingMode: opts.facingMode };
  }
  const audio = opts.audio ?? false;
  try {
    return await md.getUserMedia({ video, audio });
  } catch (err) {
    throw captureError(err, video ? 'Camera' : 'Microphone');
  }
}

/** Open the microphone alone. */
export async function openMicrophone(constraints = true) {
  return openCamera({ video: false, audio: constraints });
}

/** Stop every track of a stream — turns the camera / microphone off. Null-safe. */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** The cameras this device reports. Labels are empty until a stream has been granted once. */
export async function listCameras() {
  const md = navigator.mediaDevices;
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  const devices = await md.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

/**
 * Grab one still frame as an image Blob, at the stream's own resolution.
 *
 * Takes a playing `<video>` (whose `srcObject` is the stream) or the MediaStream itself;
 * a stream is played through a detached video element for the one frame.
 */
export async function capturePhoto(source, opts = {}) {
  const type = opts.type || 'image/jpeg';
  const quality = opts.quality ?? 0.92;
  let video = source;
  let detached = null;
  if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
    detached = document.createElement('video');
    detached.muted = true;
    detached.playsInline = true;
    detached.srcObject = source;
    await detached.play();
    video = detached;
  }
  try {
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (!blob) throw new Error('The frame could not be encoded');
    return blob;
  } finally {
    if (detached) {
      detached.pause();
      detached.srcObject = null;
    }
  }
}

// ── Recording ────────────────────────────────────────────────────

/**
 * WebM first: it is what every Chromium (Android WebView included) records, and its
 * chunks concatenate into a valid file. MP4 is recorded only where WebM is not (Safari).
 */
const VIDEO_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/** The first container/codec this browser's MediaRecorder can produce, or '' for its default. */
export function pickRecordingType(kind = 'video') {
  if (typeof MediaRecorder === 'undefined') return '';
  const list = kind === 'audio' ? AUDIO_TYPES : VIDEO_TYPES;
  for (const t of list) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

function extensionFor(mimeType, hasVideo) {
  const base = (mimeType || '').split(';')[0].trim();
  if (base === 'video/mp4' || base === 'audio/mp4') return hasVideo ? '.mp4' : '.m4a';
  if (base === 'audio/ogg') return '.ogg';
  return '.webm';
}

/** A path relative to the app's own storage, or any full `yaar://` storage URI. */
function storageUri(path) {
  if (/^yaar:\/\//.test(path)) return path;
  return `yaar://apps/self/storage/${path.replace(/^\/+/, '')}`;
}

/**
 * Record a MediaStream into a storage file, chunk by chunk, as it is captured.
 *
 * `path` is relative to the app's own storage (or a full `yaar://` storage URI). With no
 * extension, one matching the recorded container is added — read the final one from
 * `recording.path`. An existing file at that path is replaced.
 *
 * Every `timesliceMs` (default 2000) MediaRecorder hands over a chunk, which is uploaded
 * before the next one starts, so the file on the server trails the camera by about one
 * chunk. If an upload fails the recording stops, `onError` runs, and `stop()` rejects with
 * the failure — what reached the server before it is kept.
 *
 * The stream is left running when the recording ends (a preview usually still shows
 * it); stop it with `stopStream`.
 */
export function recordToStorage(stream, path, opts = {}) {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not available in this browser');
  }
  const hasVideo = stream.getVideoTracks().length > 0;
  const requested = opts.mimeType || pickRecordingType(hasVideo ? 'video' : 'audio');
  const recorderOpts = {};
  if (requested) recorderOpts.mimeType = requested;
  if (opts.videoBitsPerSecond) recorderOpts.videoBitsPerSecond = opts.videoBitsPerSecond;
  if (opts.audioBitsPerSecond) recorderOpts.audioBitsPerSecond = opts.audioBitsPerSecond;
  const recorder = new MediaRecorder(stream, recorderOpts);
  const mimeType = recorder.mimeType || requested || (hasVideo ? 'video/webm' : 'audio/webm');

  const finalPath = /\.[a-z0-9]+$/i.test(path) ? path : path + extensionFor(mimeType, hasVideo);
  const uri = storageUri(finalPath);
  const storage = y.storage;

  let bytes = 0;
  let wrote = false;
  let failure = null;
  let chain = Promise.resolve();
  const startedAt = Date.now();
  let stoppedAt = 0;

  const fail = (err) => {
    if (failure) return;
    failure = err instanceof Error ? err : new Error(String(err));
    if (recorder.state !== 'inactive') recorder.stop();
    if (opts.onError) opts.onError(failure);
  };

  recorder.addEventListener('dataavailable', (event) => {
    const chunk = event.data;
    if (!chunk || chunk.size === 0 || failure) return;
    chain = chain.then(async () => {
      if (failure) return;
      try {
        // The first chunk replaces whatever was at the path; the rest grow it.
        if (!wrote) {
          await storage.save(uri, chunk);
          wrote = true;
          bytes = chunk.size;
        } else {
          bytes = (await storage.append(uri, chunk)).size;
        }
        if (opts.onProgress) opts.onProgress({ bytes, durationMs: Date.now() - startedAt });
      } catch (err) {
        fail(err);
      }
    });
  });
  recorder.addEventListener('error', (event) => fail(event.error || new Error('Recording failed')));

  const stopped = new Promise((resolve) => {
    recorder.addEventListener(
      'stop',
      () => {
        stoppedAt = Date.now();
        resolve();
      },
      { once: true },
    );
  });

  recorder.start(opts.timesliceMs ?? 2000);

  return {
    path: finalPath,
    uri,
    mimeType,
    get bytes() {
      return bytes;
    },
    get state() {
      return recorder.state;
    },
    get durationMs() {
      return (stoppedAt || Date.now()) - startedAt;
    },
    pause() {
      if (recorder.state === 'recording') recorder.pause();
    },
    resume() {
      if (recorder.state === 'paused') recorder.resume();
    },
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      // The final chunk is dispatched before 'stop', so the chain already holds it.
      await chain;
      if (failure) throw failure;
      return { path: finalPath, uri, mimeType, bytes, durationMs: stoppedAt - startedAt };
    },
  };
}
