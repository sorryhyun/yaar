/**
 * yt-dlp download jobs — the state behind `yaar://system/ytdlp`.
 *
 * Same shape as features/update/updater.ts, generalized from a singleton to a
 * small job table: `invoke {action:'download'}` returns as soon as the job is
 * *started*, refusals are thrown synchronously, and `read` reports from memory
 * only — a UI can poll it every second and never trigger a spawn or a fetch.
 *
 * Downloads land in the storage commons (`shared/media/`), never at a
 * caller-chosen path: the ytdlp grant must not double as a storage-write grant,
 * so the destination is this module's decision, made once, here. The bytes go
 * tmpdir → storageWriteStream rather than straight into storage, keeping every
 * write to the storage tree inside storage-manager's validation.
 *
 * URLs are gated to YouTube hosts. yt-dlp's generic extractor will fetch any
 * URL it is handed — pointed at an internal host, that is SSRF with a binary in
 * the middle — so the allowlist is the boundary, and widening it is a decision
 * about *that*, not about formats.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  downloadAudio,
  isYtDlpAvailable,
  resolveMediaInfo,
  resolveYtDlpPath,
  ytDlpVersion,
  YtDlpError,
  type DownloadAudioResult,
  type YtDlpMediaInfo,
} from '../../lib/ytdlp/index.js';
import { storageWriteStream } from '../../storage/storage-manager.js';
import { genId } from '../../lib/ids.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('YtDlpJobs');

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const MAX_ACTIVE_JOBS = 2;
const MAX_KEPT_JOBS = 20;
/** Where every download lands, relative to the storage root — the commons, so any app can read it. */
const DEST_DIR = 'shared/media';

/** Thrown for refusals that are the caller's to fix; the handler renders them as `error()`. */
export class YtDlpRequestError extends Error {}

export interface YtDlpJob {
  id: string;
  url: string;
  stage: 'downloading' | 'saving' | 'done' | 'error' | 'cancelled';
  title?: string;
  durationSec?: number | null;
  /** Set when done: where the audio landed. */
  uri?: string;
  bytes?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface ActiveJob {
  job: YtDlpJob;
  abort: AbortController;
}

const jobs = new Map<string, ActiveJob>();

/** Test seams — the real lib calls, replaceable so job-lifecycle tests never spawn yt-dlp. */
let impl = { downloadAudio, resolveMediaInfo, isYtDlpAvailable, ytDlpVersion };

export function setYtDlpImplForTest(overrides: Partial<typeof impl>): void {
  impl = { ...impl, ...overrides };
}

export function resetYtDlpJobsForTest(): void {
  impl = { downloadAudio, resolveMediaInfo, isYtDlpAvailable, ytDlpVersion };
  jobs.clear();
  cachedVersion = undefined;
}

/** Refuse anything that is not a YouTube video URL. Returns the parsed URL. */
export function requireSupportedUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw) {
    throw new YtDlpRequestError('Provide `url`: a YouTube video URL.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new YtDlpRequestError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new YtDlpRequestError('Only http(s) URLs are supported.');
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new YtDlpRequestError(
      `Host ${url.hostname} is not supported — only YouTube URLs (${[...ALLOWED_HOSTS].join(', ')}).`,
    );
  }
  return url;
}

let cachedVersion: string | null | undefined;

export interface YtDlpStatus {
  available: boolean;
  version: string | null;
  binaryPath: string | null;
  jobs: YtDlpJob[];
}

/** Current status. First call probes the binary version; after that, memory only. */
export async function getYtDlpStatus(): Promise<YtDlpStatus> {
  if (cachedVersion === undefined) {
    cachedVersion = impl.isYtDlpAvailable() ? await impl.ytDlpVersion() : null;
  }
  return {
    available: impl.isYtDlpAvailable(),
    version: cachedVersion,
    binaryPath: resolveYtDlpPath(),
    jobs: [...jobs.values()].map((a) => a.job).sort((a, b) => b.startedAt - a.startedAt),
  };
}

/** Metadata + audio format list for a URL. Blocking, no media bytes. */
export async function resolveMedia(rawUrl: unknown): Promise<YtDlpMediaInfo> {
  const url = requireSupportedUrl(rawUrl);
  requireAvailable();
  return impl.resolveMediaInfo(url.href);
}

/**
 * Start an audio download job. Returns the job snapshot immediately; poll `read`
 * for progress. The finished file is announced on the job as `yaar://storage/…`.
 */
export function startAudioDownload(rawUrl: unknown): YtDlpJob {
  const url = requireSupportedUrl(rawUrl);
  requireAvailable();

  const active = [...jobs.values()].filter(
    (a) => a.job.stage === 'downloading' || a.job.stage === 'saving',
  );
  if (active.length >= MAX_ACTIVE_JOBS) {
    throw new YtDlpRequestError(
      `${MAX_ACTIVE_JOBS} downloads are already running — wait for one to finish or cancel it.`,
    );
  }
  const duplicate = active.find((a) => a.job.url === url.href);
  if (duplicate) {
    throw new YtDlpRequestError(`Already downloading that URL (job ${duplicate.job.id}).`);
  }

  const job: YtDlpJob = {
    id: genId('ytdlp', 6),
    url: url.href,
    stage: 'downloading',
    startedAt: Date.now(),
  };
  const abort = new AbortController();
  jobs.set(job.id, { job, abort });
  pruneFinished();

  void runJob(job, abort.signal).catch((err) => {
    // runJob records its own failures; this catch is for bugs in the recording itself.
    log.error('ytdlp job crashed outside its own error handling', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { ...job };
}

/** Cancel a running job. Finished jobs are not cancellable. */
export function cancelDownload(jobId: unknown): YtDlpJob {
  const active = typeof jobId === 'string' ? jobs.get(jobId) : undefined;
  if (!active) {
    throw new YtDlpRequestError(`No such job: ${String(jobId)}. Read the resource to list jobs.`);
  }
  const { job } = active;
  if (job.stage !== 'downloading' && job.stage !== 'saving') {
    throw new YtDlpRequestError(`Job ${job.id} is already ${job.stage}.`);
  }
  active.abort.abort();
  job.stage = 'cancelled';
  job.finishedAt = Date.now();
  return { ...job };
}

async function runJob(job: YtDlpJob, signal: AbortSignal): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'yaar-ytdlp-'));
  try {
    const result = await impl.downloadAudio(job.url, tmp, { signal });
    if (settle(job, signal)) return;
    job.title = result.title;
    job.durationSec = result.durationSec;
    job.stage = 'saving';

    const storagePath = await saveToStorage(result);
    if (settle(job, signal)) return;
    job.stage = 'done';
    job.uri = `yaar://storage/${storagePath}`;
    job.bytes = result.bytes;
    job.finishedAt = Date.now();
    log.info('ytdlp download finished', { jobId: job.id, bytes: result.bytes });
  } catch (err) {
    if (settle(job, signal)) return;
    job.stage = 'error';
    job.error = err instanceof YtDlpError ? err.message : 'Download failed';
    job.finishedAt = Date.now();
    if (err instanceof YtDlpError) {
      log.warn('ytdlp download failed', { jobId: job.id, error: job.error });
    } else {
      log.error('ytdlp job hit an unexpected error', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** True when the job was cancelled while we were away; leaves the cancel record intact. */
function settle(job: YtDlpJob, signal: AbortSignal): boolean {
  return signal.aborted || job.stage === 'cancelled';
}

/** Stream the finished tmp file into the commons; returns the storage-relative path. */
async function saveToStorage(result: DownloadAudioResult): Promise<string> {
  const safeId = result.id.replace(/[^\w-]/g, '') || 'audio';
  const ext = extname(result.filePath) || '.m4a';
  const storagePath = `${DEST_DIR}/${safeId}${ext}`;

  const opened = await storageWriteStream(storagePath);
  if (!opened.success) {
    throw new YtDlpError(`Could not write to storage: ${opened.error ?? 'unknown error'}`, '');
  }
  const { stream } = opened;
  try {
    const reader = Bun.file(result.filePath).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await stream.write(value);
    }
    const committed = await stream.commit();
    if (!committed.success) {
      throw new YtDlpError(`Could not save to storage: ${committed.error ?? 'unknown error'}`, '');
    }
    return storagePath;
  } catch (err) {
    await stream.abort().catch(() => {});
    throw err;
  }
}

function requireAvailable(): void {
  if (!impl.isYtDlpAvailable()) {
    throw new YtDlpRequestError(
      'yt-dlp is not installed on this machine. Install it (e.g. `brew install yt-dlp`, or the ' +
        'standalone binary into ~/.local/bin) or set YTDLP_PATH, then retry.',
    );
  }
}

/** Keep the table bounded: drop the oldest finished jobs past MAX_KEPT_JOBS. */
function pruneFinished(): void {
  const finished = [...jobs.values()]
    .filter((a) => a.job.finishedAt !== undefined)
    .sort((a, b) => a.job.finishedAt! - b.job.finishedAt!);
  let excess = jobs.size - MAX_KEPT_JOBS;
  for (const a of finished) {
    if (excess <= 0) break;
    jobs.delete(a.job.id);
    excess--;
  }
}
