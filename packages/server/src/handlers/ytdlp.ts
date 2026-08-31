/**
 * yt-dlp domain handler — media download via the optional yt-dlp binary.
 *
 *   read('yaar://system/ytdlp')                            → availability, version, job table
 *   invoke('yaar://system/ytdlp', { action:'resolve',  url })   → metadata + audio formats, no bytes
 *   invoke('yaar://system/ytdlp', { action:'download', url })   → starts a job, returns its snapshot
 *   invoke('yaar://system/ytdlp', { action:'cancel',   jobId }) → kills a running job
 *
 * `download` returns as soon as the job is started (a long video outlives the
 * MCP tool-call ceiling, so blocking is not an option); the caller polls `read`
 * until the job's stage is `done` and its `uri` names the file in the storage
 * commons. `read` is memory-only past the first version probe, so polling is free.
 *
 * yt-dlp is discovered, never bundled — when absent, `read` says so and every
 * action refuses with install guidance. URL and destination policy (YouTube
 * hosts only, downloads land in `shared/media/`) lives in features/ytdlp/jobs.ts.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import { okJson, error } from './utils.js';
import { defineActions } from './define-actions.js';
import {
  cancelDownload,
  getYtDlpStatus,
  resolveMedia,
  startAudioDownload,
  YtDlpRequestError,
} from '../features/ytdlp/jobs.js';
import { YtDlpError } from '../lib/ytdlp/index.js';

type Payload = { url?: unknown; jobId?: unknown };

const ACTIONS = defineActions<Payload>(
  {
    resolve: {
      description: 'Fetch metadata and the audio-only format list for `url`. No media bytes.',
      run: async (payload) => okJson(await resolveMedia(payload.url)),
    },
    download: {
      description:
        'Start downloading the best audio-only track of `url` into shared/media/. Returns the ' +
        'job immediately; poll `read` until its stage is `done` and `uri` names the file.',
      run: async (payload) => okJson(startAudioDownload(payload.url)),
    },
    cancel: {
      description: 'Cancel the running download job named by `jobId`.',
      run: async (payload) => okJson(cancelDownload(payload.jobId)),
    },
  },
  { describe: 'What to do: resolve metadata, start a download, or cancel one.' },
);

const INVOKE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: ACTIONS.schema,
    url: {
      type: 'string',
      description: 'YouTube video URL (youtube.com / youtu.be). For `resolve` and `download`.',
    },
    jobId: {
      type: 'string',
      description: 'Job to cancel, as `read` lists them. For `cancel` only.',
    },
  },
  required: ['action'],
};

export function registerYtDlpHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://system/ytdlp', {
    description:
      'Audio download from YouTube via the yt-dlp binary — the door for long videos, which ' +
      'YouTube refuses to serve whole over plain InnerTube URLs. Optional: read reports whether ' +
      'yt-dlp is installed on this machine. Downloads land in the storage commons ' +
      '(yaar://storage/shared/media/) so any app can read the result.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: INVOKE_SCHEMA,

    async read(): Promise<VerbResult> {
      return okJson(await getYtDlpStatus());
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const request = (payload ?? {}) as Payload & { action?: unknown };
      try {
        return await ACTIONS.dispatch(String(request.action ?? ''), request);
      } catch (err) {
        // A refused request is the caller's mistake and reads as one; a failure inside
        // yt-dlp itself carries its ERROR: line. Anything else is a bug here.
        if (err instanceof YtDlpRequestError || err instanceof YtDlpError) {
          return error(err.message);
        }
        throw err;
      }
    },
  });
}
