/**
 * yt-dlp jobs + handler tests. Everything runs against injected fakes
 * (setYtDlpImplForTest) — a test must not depend on whether this machine has
 * yt-dlp installed, and must never spawn it. Storage writes are real, landing
 * in the temp storage root the test env pins.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  cancelDownload,
  getYtDlpStatus,
  requireSupportedUrl,
  resetYtDlpJobsForTest,
  setYtDlpImplForTest,
  startAudioDownload,
  YtDlpRequestError,
  type YtDlpJob,
} from './jobs.js';
import { YtDlpError, type DownloadAudioResult } from '../../lib/ytdlp/index.js';
import { ResourceRegistry } from '../../handlers/uri-registry.js';
import { registerYtDlpHandlers } from '../../handlers/ytdlp.js';

const URL_OK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

afterEach(() => {
  resetYtDlpJobsForTest();
});

function available(): void {
  setYtDlpImplForTest({ isYtDlpAvailable: () => true, ytDlpVersion: async () => '2026.08.19' });
}

/** A downloadAudio fake that writes a real tmp file, as the binary would. */
function fakeDownload(id = 'vid01'): typeof import('../../lib/ytdlp/index.js').downloadAudio {
  return async (_url, destDir): Promise<DownloadAudioResult> => {
    const filePath = join(destDir, `${id}.m4a`);
    await Bun.write(filePath, 'audio-bytes');
    return { filePath, bytes: 11, id, title: 'A Title', durationSec: 19 };
  };
}

async function untilFinished(jobId: string): Promise<YtDlpJob> {
  for (let i = 0; i < 200; i++) {
    const { jobs } = await getYtDlpStatus();
    const job = jobs.find((j) => j.id === jobId);
    if (job && job.stage !== 'downloading' && job.stage !== 'saving') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} never finished`);
}

describe('requireSupportedUrl', () => {
  test('accepts YouTube hosts', () => {
    expect(requireSupportedUrl(URL_OK).hostname).toBe('www.youtube.com');
    expect(requireSupportedUrl('https://youtu.be/jNQXAC9IVRw').hostname).toBe('youtu.be');
    expect(requireSupportedUrl('https://music.youtube.com/watch?v=x').hostname).toBe(
      'music.youtube.com',
    );
  });

  test('refuses other hosts, bad URLs, and non-http schemes', () => {
    expect(() => requireSupportedUrl('https://vimeo.com/123')).toThrow(YtDlpRequestError);
    expect(() => requireSupportedUrl('https://evil.test/?u=youtube.com')).toThrow(
      YtDlpRequestError,
    );
    expect(() => requireSupportedUrl('not a url')).toThrow(YtDlpRequestError);
    expect(() => requireSupportedUrl('ftp://youtube.com/x')).toThrow(YtDlpRequestError);
    expect(() => requireSupportedUrl(undefined)).toThrow(YtDlpRequestError);
  });
});

describe('download jobs', () => {
  test('refuses when yt-dlp is unavailable', () => {
    setYtDlpImplForTest({ isYtDlpAvailable: () => false });
    expect(() => startAudioDownload(URL_OK)).toThrow(/not installed/);
  });

  test('happy path: downloads land in shared/media and the job records the URI', async () => {
    available();
    setYtDlpImplForTest({ downloadAudio: fakeDownload('abc-123') });

    const started = startAudioDownload(URL_OK);
    expect(started.stage).toBe('downloading');

    const job = await untilFinished(started.id);
    expect(job.stage).toBe('done');
    expect(job.uri).toBe('yaar://storage/shared/media/abc-123.m4a');
    expect(job.title).toBe('A Title');
    expect(job.bytes).toBe(11);

    // The bytes really landed in the (test-pinned) storage root.
    const storageRoot = process.env.YAAR_STORAGE;
    expect(storageRoot).toBeTruthy();
    expect(existsSync(join(storageRoot!, 'shared/media/abc-123.m4a'))).toBe(true);
  });

  test('a failing download records the yt-dlp error on the job', async () => {
    available();
    setYtDlpImplForTest({
      downloadAudio: async () => {
        throw new YtDlpError('ERROR: [youtube] nope: This video is unavailable', '');
      },
    });
    const started = startAudioDownload(URL_OK);
    const job = await untilFinished(started.id);
    expect(job.stage).toBe('error');
    expect(job.error).toContain('This video is unavailable');
  });

  test('cancel kills a running job and the record stays cancelled', async () => {
    available();
    setYtDlpImplForTest({
      downloadAudio: (_url, _dest, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new YtDlpError('Cancelled', '')));
        }),
    });
    const started = startAudioDownload(URL_OK);
    const cancelled = cancelDownload(started.id);
    expect(cancelled.stage).toBe('cancelled');

    const job = await untilFinished(started.id);
    expect(job.stage).toBe('cancelled');
    expect(job.error).toBeUndefined();
  });

  test('cancel refuses unknown and finished jobs', async () => {
    available();
    setYtDlpImplForTest({ downloadAudio: fakeDownload() });
    expect(() => cancelDownload('ytdlp-nope')).toThrow(/No such job/);

    const started = startAudioDownload(URL_OK);
    await untilFinished(started.id);
    expect(() => cancelDownload(started.id)).toThrow(/already done/);
  });

  test('caps concurrent jobs and refuses a duplicate URL', () => {
    available();
    // Downloads that never settle, so both slots stay occupied.
    setYtDlpImplForTest({ downloadAudio: () => new Promise(() => {}) });

    startAudioDownload(URL_OK);
    expect(() => startAudioDownload(URL_OK)).toThrow(/Already downloading/);
    startAudioDownload('https://youtu.be/other-1');
    expect(() => startAudioDownload('https://youtu.be/other-2')).toThrow(/already running/);
  });
});

describe('yaar://system/ytdlp handler', () => {
  function registry(): ResourceRegistry {
    const reg = new ResourceRegistry();
    registerYtDlpHandlers(reg);
    return reg;
  }

  test('read reports availability without spawning', async () => {
    setYtDlpImplForTest({ isYtDlpAvailable: () => false });
    const result = await registry().execute('read', 'yaar://system/ytdlp');
    expect(result.isError).toBeFalsy();
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(JSON.parse(text).available).toBe(false);
  });

  test('an unknown action is refused by name', async () => {
    const result = await registry().execute('invoke', 'yaar://system/ytdlp', { action: 'bogus' });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('resolve, download, cancel');
  });

  test('a refused request reads as a caller error, not a throw', async () => {
    available();
    const result = await registry().execute('invoke', 'yaar://system/ytdlp', {
      action: 'download',
      url: 'https://vimeo.com/123',
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('not supported');
  });
});
