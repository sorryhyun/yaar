export {};
import { AppCommandError, appStorage, errMsg, storage } from '@bundled/yaar';
import { activeProject } from '../core';
import {
  analyzeAudio,
  compareReports,
  projectPath,
  spectrogram,
  type AudioInput,
  type AudioReport,
  type Spectrogram,
} from '../lib';

// Reading an audio file and measuring it, for `analyzeAudio`. The measuring is
// `lib/audio-analysis.ts`; this is the I/O around it — fetch the bytes, decode, paint.
//
// It runs in *this* iframe, not the preview's: a render the preview wrote is a file in
// storage by then, so no preview needs to be open, and the measurement code is ours
// rather than something re-typed into a `previewEval` each time.

/**
 * Everything is decoded at one rate. Loudness and band shares do not depend on it, and a
 * fixed rate keeps two files compared with `compareTo` on the same FFT grid.
 */
const ANALYSIS_RATE = 48_000;

/** Past this a slice is the better question, and the analysis would take long enough to time out. */
const MAX_ANALYZED_SEC = 600;

async function readBytes(ref: string): Promise<ArrayBuffer> {
  // The `yaar://` scheme and nothing looser, as in storage-import: a bare path names
  // the project, so storage can never shadow a project file of the same spelling.
  if (ref.startsWith('yaar://')) {
    let url: string;
    try {
      url = storage.url(ref);
    } catch (err) {
      throw new AppCommandError(`${ref} is not a storage file: ${errMsg(err)}`);
    }
    // `fetch`, not a verb read: the verb layer answers a binary file with a notice, and
    // the bytes are what is being measured.
    const res = await fetch(url);
    if (!res.ok) {
      throw new AppCommandError(
        `Could not read ${ref}: HTTP ${res.status}${res.status === 404 ? ' (no such file)' : ''}.`,
      );
    }
    return await res.arrayBuffer();
  }
  const proj = activeProject();
  if (!proj) {
    throw new AppCommandError(
      `"${ref}" reads as a project path and no project is active. Pass a yaar:// storage URI.`,
    );
  }
  try {
    return await (await appStorage.readBlob(projectPath(proj.id, ref))).arrayBuffer();
  } catch {
    throw new AppCommandError(`No file "${ref}" in the active project.`);
  }
}

async function decode(ref: string, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const size = bytes.byteLength;
  try {
    // A one-frame offline context never renders; it is only the decoder, and needs no
    // user gesture the way an AudioContext would.
    return await new OfflineAudioContext(2, 1, ANALYSIS_RATE).decodeAudioData(bytes);
  } catch (err) {
    throw new AppCommandError(
      `Could not decode ${ref} (${size} bytes) as audio: ${errMsg(err)}. WAV, FLAC, MP3, ` +
        'OGG/Opus and M4A/AAC decode. A file roughly twice the size it should be went ' +
        'through a text read somewhere, which corrupts every byte above 0x7F.',
    );
  }
}

function sliceInput(buf: AudioBuffer, startSec = 0, durationSec?: number): AudioInput {
  const sr = buf.sampleRate;
  const from = Math.max(0, Math.min(buf.length, Math.round(startSec * sr)));
  const wanted = durationSec !== undefined ? Math.round(durationSec * sr) : buf.length - from;
  const to = Math.min(buf.length, from + Math.max(0, wanted), from + MAX_ANALYZED_SEC * sr);
  if (to <= from) {
    throw new AppCommandError(
      `Nothing to analyze: the file is ${(buf.length / sr).toFixed(2)}s long and the slice ` +
        `starts at ${startSec}s.`,
    );
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++)
    channels.push(buf.getChannelData(c).subarray(from, to));
  return { channels, sampleRate: sr };
}

export interface AudioAnalysis {
  ref: string;
  report: AudioReport;
  /** Set when the file ran past MAX_ANALYZED_SEC and only the start was measured. */
  truncated?: string;
  image?: string;
}

export interface AudioOptions {
  startSec?: number;
  durationSec?: number;
  segments?: number;
  image?: boolean;
}

export async function analyzeAudioFile(
  ref: string,
  opts: AudioOptions = {},
): Promise<AudioAnalysis> {
  const buf = await decode(ref, await readBytes(ref));
  const input = sliceInput(buf, opts.startSec, opts.durationSec);
  const report = analyzeAudio(input, { segments: opts.segments });
  // The timeline is measured from the slice's start; report it against the file's.
  const offset = Math.max(0, opts.startSec ?? 0);
  if (offset)
    report.timeline = report.timeline.map((s) => ({
      ...s,
      t: Math.round((s.t + offset) * 100) / 100,
    }));
  const analyzed = input.channels[0].length / input.sampleRate;
  const remaining = buf.duration - (opts.startSec ?? 0);
  const truncated =
    opts.durationSec === undefined && remaining > analyzed + 0.01
      ? `Only the first ${MAX_ANALYZED_SEC}s were analyzed; pass startSec/durationSec for the rest.`
      : undefined;
  return {
    ref,
    report,
    ...(truncated ? { truncated } : {}),
    ...(opts.image === false ? {} : { image: paintSpectrogram(spectrogram(input), ref, report) }),
  };
}

export { compareReports };

// -- the picture -----------------------------------------------------------------

/** A perceptual dark-to-bright ramp (inferno-like), so a louder band is always brighter. */
const RAMP: Array<[number, number, number]> = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];

function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [RAMP[i], RAMP[i + 1]];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const fmtHz = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

/**
 * Waveform strip over a log-frequency spectrogram, axes labelled, as base64 PNG. The
 * colour range is the loudest 90 dB of this file, so two images are compared by their
 * shapes and the numbers, never by brightness.
 */
function paintSpectrogram(spec: Spectrogram, ref: string, report: AudioReport): string {
  const left = 40;
  const top = 18;
  const waveH = 64;
  const rowPx = 2;
  const specH = spec.rows * rowPx;
  const bottom = 16;
  const width = left + spec.cols;
  const height = top + waveH + 4 + specH + bottom;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#c9d1d9';
  const name = ref.split('/').pop() ?? ref;
  const lufs = report.integratedLufs === null ? '—' : `${report.integratedLufs} LUFS`;
  const peak = report.peakDb === null ? '—' : `${report.peakDb} dBFS peak`;
  ctx.fillText(`${name} · ${report.durationSec}s · ${lufs} · ${peak}`, left, 12);

  // Waveform: per-column min/max of the mono mix, with the ±1 rails drawn.
  const mid = top + waveH / 2;
  ctx.strokeStyle = '#30363d';
  ctx.strokeRect(left, top, spec.cols, waveH);
  ctx.fillStyle = '#58a6ff';
  for (let c = 0; c < spec.cols; c++) {
    const y0 = mid - spec.waveMax[c] * (waveH / 2);
    const y1 = mid - spec.waveMin[c] * (waveH / 2);
    ctx.fillRect(left + c, y0, 1, Math.max(1, y1 - y0));
  }

  const specTop = top + waveH + 4;
  let max = -Infinity;
  for (const v of spec.db) if (v > max) max = v;
  const floor = max - 90;
  const img = ctx.createImageData(spec.cols, specH);
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      const [R, G, B] = rampColor((spec.db[r * spec.cols + c] - floor) / 90);
      for (let k = 0; k < rowPx; k++) {
        // Rows run from the lowest frequency; the image runs top-down.
        const y = specH - 1 - (r * rowPx + k);
        const o = (y * spec.cols + c) * 4;
        img.data[o] = R;
        img.data[o + 1] = G;
        img.data[o + 2] = B;
        img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, left, specTop);

  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'right';
  const logMin = Math.log(spec.minHz);
  const logSpan = Math.log(spec.maxHz) - logMin;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (hz < spec.minHz || hz > spec.maxHz) continue;
    const y = specTop + specH - ((Math.log(hz) - logMin) / logSpan) * specH;
    ctx.fillText(fmtHz(hz), left - 4, y + 4);
    ctx.fillRect(left - 2, y, 2, 1);
  }
  ctx.textAlign = 'center';
  const dur = report.durationSec;
  const stepSec = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => dur / s <= 10) ?? 120;
  for (let t = 0; t <= dur + 1e-9; t += stepSec) {
    const x = left + (t / dur) * spec.cols;
    ctx.fillText(`${Number(t.toFixed(2))}s`, Math.min(width - 14, x), height - 4);
  }
  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}
