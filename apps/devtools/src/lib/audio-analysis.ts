export {};

// Measurements an agent can reason about in place of listening.
//
// An agent cannot hear a render. Before this existed it re-derived these numbers by hand
// inside `previewEval` on every iteration (fetch the WAV, decode it, loop over samples), and
// each derivation was a fresh chance to get the arithmetic wrong. One audited implementation,
// fed decoded PCM by `services/audio.ts`; pure, so the `audio-analysis` suite can pin it
// against signals whose answers are known.
//
// Loudness follows ITU-R BS.1770-4 (K-weighting, 400 ms blocks at 75% overlap, absolute
// -70 LUFS and relative -10 LU gates) and EBU Tech 3342 for loudness range. Peak is the
// sample peak, not true peak — an inter-sample overshoot of up to ~0.5 dB is not seen.

export interface AudioInput {
  /** One array per channel, equal lengths. Only the first two are measured. */
  channels: Float32Array[];
  sampleRate: number;
}

export interface TimelineSegment {
  /** Segment start, seconds. */
  t: number;
  /** K-weighted loudness of the segment, ungated. Null when the segment is silent. */
  lufs: number | null;
  peakDb: number | null;
}

export interface AudioReport {
  durationSec: number;
  channels: number;
  sampleRate: number;
  /** BS.1770 integrated loudness. Null when nothing passes the absolute gate (silence, < 0.4 s). */
  integratedLufs: number | null;
  /** Loudest 3 s window. */
  shortTermMaxLufs: number | null;
  /** EBU loudness range: spread of the short-term loudness, 10th to 95th percentile. */
  loudnessRangeLu: number | null;
  /** Sample peak across channels, dBFS. */
  peakDb: number | null;
  rmsDb: number | null;
  /** Peak minus RMS. A heavily limited master sits near 6 dB, an unprocessed mix above 15. */
  crestDb: number | null;
  /** Samples at or above 0.999 full scale. */
  clippedSamples: number;
  dcOffset: number;
  silence: { leadingSec: number; trailingSec: number; silentPct: number };
  /** Two channels only. Correlation +1 is mono, 0 is wide, below 0 cancels in mono. */
  stereo?: { correlation: number; sideToMidDb: number | null; balanceDb: number | null };
  /** Each band's share of the total energy, dB (0 = all of it). */
  bandsDb: Record<BandName, number | null>;
  /** Energy-weighted mean frequency — a single "brightness" number. */
  spectralCentroidHz: number | null;
  timeline: TimelineSegment[];
  /** From onset autocorrelation; octave errors (half/double) are the usual way it is wrong. */
  tempo: { bpm: number; confidence: number } | null;
  onsetsPerSec: number | null;
}

export type BandName = 'sub' | 'bass' | 'lowMid' | 'mid' | 'upperMid' | 'presence' | 'brilliance';

/** Conventional mixing bands, Hz. */
export const BANDS: ReadonlyArray<readonly [BandName, number, number]> = [
  ['sub', 20, 60],
  ['bass', 60, 250],
  ['lowMid', 250, 500],
  ['mid', 500, 2000],
  ['upperMid', 2000, 4000],
  ['presence', 4000, 6000],
  ['brilliance', 6000, 20000],
];

export interface Spectrogram {
  cols: number;
  rows: number;
  minHz: number;
  maxHz: number;
  /** Row-major from the lowest frequency, `cols * rows` power values in dB. */
  db: Float32Array;
  /** Per column, the mono mix's min and max sample — the waveform strip. */
  waveMin: Float32Array;
  waveMax: Float32Array;
}

const FFT_SIZE = 2048;
const HOP = 512;
const SILENCE_DB = -60;

const round = (n: number, places = 1) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const finiteOrNull = (n: number, places = 1) => (Number.isFinite(n) ? round(n, places) : null);

// -- K-weighting ---------------------------------------------------------------

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two BS.1770 pre-filter stages, designed for any sample rate from their analog
 * parameters (the published coefficients are for 48 kHz only). The bilinear-transform
 * form libebur128 uses: it reproduces the published 48 kHz coefficients, which the RBJ
 * cookbook shelf fed the same parameters does not (it reads ~0.4 dB low at 1 kHz).
 * The high-pass numerator is the spec's unnormalized [1, -2, 1].
 */
export function kWeightingFilters(fs: number): [Biquad, Biquad] {
  const shelfGainDb = 3.99984385397;
  const shelfQ = 0.7071752369554193;
  const shelfFc = 1681.9744509555319;
  const hpQ = 0.5003270373253953;
  const hpFc = 38.13547087613982;

  let K = Math.tan((Math.PI * shelfFc) / fs);
  const Vh = 10 ** (shelfGainDb / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / shelfQ + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / shelfQ + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / shelfQ + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / shelfQ + K * K) / a0,
  };

  K = Math.tan((Math.PI * hpFc) / fs);
  a0 = 1 + K / hpQ + K * K;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / hpQ + K * K) / a0,
  };
  return [shelf, highpass];
}

function applyBiquad(x: Float32Array | Float64Array, f: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/**
 * K-weighted energy per 100 ms sub-block, summed over channels (BS.1770 weights L and R
 * at 1). Every window the loudness measures is a whole number of sub-blocks, so this is
 * the only pass over the samples — a prefix sum would cost 8 bytes per sample.
 */
function subBlockEnergy(input: AudioInput, chans: Float32Array[]): Float64Array {
  const step = Math.round(input.sampleRate / 10);
  const n = Math.floor(chans[0].length / step);
  const out = new Float64Array(n);
  const [shelf, hp] = kWeightingFilters(input.sampleRate);
  for (const ch of chans) {
    const y = applyBiquad(applyBiquad(ch, shelf), hp);
    for (let b = 0; b < n; b++) {
      let sum = 0;
      for (let i = b * step, end = i + step; i < end; i++) sum += y[i] * y[i];
      out[b] += sum / step;
    }
  }
  return out;
}

const blockLoudness = (meanSquare: number) => -0.691 + db(meanSquare);

/** Mean of each run of `width` consecutive sub-blocks, advancing one sub-block at a time. */
function windows(sub: Float64Array, width: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < sub.length; i++) {
    acc += sub[i];
    if (i >= width) acc -= sub[i - width];
    if (i >= width - 1) out.push(acc / width);
  }
  return out;
}

function integrated(blocks: number[]): number {
  const loud = blocks.filter((z) => blockLoudness(z) > -70);
  if (loud.length === 0) return -Infinity;
  const mean = (zs: number[]) => zs.reduce((a, b) => a + b, 0) / zs.length;
  const relativeGate = blockLoudness(mean(loud)) - 10;
  const kept = loud.filter((z) => blockLoudness(z) > relativeGate);
  return kept.length ? blockLoudness(mean(kept)) : -Infinity;
}

function loudnessRange(shortTerm: number[]): number {
  const loud = shortTerm.filter((z) => blockLoudness(z) > -70);
  if (loud.length < 2) return NaN;
  const mean = loud.reduce((a, b) => a + b, 0) / loud.length;
  const gate = blockLoudness(mean) - 20;
  const ls = loud
    .map(blockLoudness)
    .filter((l) => l > gate)
    .sort((a, b) => a - b);
  if (ls.length < 2) return NaN;
  const at = (p: number) =>
    ls[Math.min(ls.length - 1, Math.max(0, Math.round(p * (ls.length - 1))))];
  return at(0.95) - at(0.1);
}

// -- FFT -----------------------------------------------------------------------

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function monoMix(chans: Float32Array[]): Float32Array {
  if (chans.length === 1) return chans[0];
  const out = new Float32Array(chans[0].length);
  for (const ch of chans) for (let i = 0; i < out.length; i++) out[i] += ch[i] / chans.length;
  return out;
}

interface Stft {
  /** Mean power spectrum over all frames, `FFT_SIZE / 2 + 1` bins. */
  meanPower: Float64Array;
  /** Half-wave-rectified log-magnitude flux per frame — the onset strength envelope. */
  flux: Float64Array;
  frames: number;
}

/** One STFT pass over the mono mix; `perFrame` sees each frame's power spectrum. */
function stft(mono: Float32Array, perFrame?: (frame: number, power: Float64Array) => void): Stft {
  const bins = FFT_SIZE / 2 + 1;
  const frames = mono.length >= FFT_SIZE ? Math.floor((mono.length - FFT_SIZE) / HOP) + 1 : 0;
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  // Hann's coherent power gain, so a full-scale sine's bin reads near 0 dB.
  const norm = 1 / ((FFT_SIZE / 2) * (FFT_SIZE / 2) * 0.25);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(bins);
  const prevLog = new Float64Array(bins);
  const meanPower = new Float64Array(bins);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let rise = 0;
    for (let k = 0; k < bins; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) * norm;
      power[k] = p;
      meanPower[k] += p;
      const lg = Math.log1p(1000 * Math.sqrt(p));
      if (f > 0 && lg > prevLog[k]) rise += lg - prevLog[k];
      prevLog[k] = lg;
    }
    flux[f] = rise;
    perFrame?.(f, power);
  }
  if (frames > 0) for (let k = 0; k < bins; k++) meanPower[k] /= frames;
  return { meanPower, flux, frames };
}

function bandShares(meanPower: Float64Array, sampleRate: number): Record<BandName, number | null> {
  const binHz = sampleRate / FFT_SIZE;
  const nyquist = sampleRate / 2;
  let total = 0;
  for (let k = 0; k < meanPower.length; k++) if (k * binHz >= 20) total += meanPower[k];
  const out = {} as Record<BandName, number | null>;
  for (const [name, lo, hi] of BANDS) {
    if (lo >= nyquist || total <= 0) {
      out[name] = null;
      continue;
    }
    let sum = 0;
    for (let k = 0; k < meanPower.length; k++) {
      const hz = k * binHz;
      if (hz >= lo && hz < hi) sum += meanPower[k];
    }
    out[name] = sum > 0 ? round(db(sum / total)) : null;
  }
  return out;
}

function centroid(meanPower: Float64Array, sampleRate: number): number {
  const binHz = sampleRate / FFT_SIZE;
  let num = 0;
  let den = 0;
  for (let k = 1; k < meanPower.length; k++) {
    num += k * binHz * meanPower[k];
    den += meanPower[k];
  }
  return den > 0 ? num / den : NaN;
}

/**
 * Tempo from the autocorrelation of the onset envelope, 60–200 BPM, weighted toward
 * 120 the way most beat trackers are (a log-normal prior an octave wide) — without it
 * a straight four-on-the-floor reads as often at half or double time as at the beat.
 */
function estimateTempo(
  flux: Float64Array,
  sampleRate: number,
): { bpm: number; confidence: number } | null {
  const fps = sampleRate / HOP;
  if (flux.length < fps * 4) return null;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const x = Array.from(flux, (v) => v - mean);
  let zero = 0;
  for (const v of x) zero += v * v;
  if (zero <= 0) return null;
  const minLag = Math.floor((60 / 200) * fps);
  const maxLag = Math.ceil((60 / 60) * fps);
  let best = -Infinity;
  let bestLag = 0;
  let bestRaw = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = lag; i < x.length; i++) acc += x[i] * x[i - lag];
    const raw = acc / zero;
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (raw * prior > best) {
      best = raw * prior;
      bestLag = lag;
      bestRaw = raw;
    }
  }
  if (bestLag === 0 || bestRaw <= 0) return null;
  return { bpm: round((60 * fps) / bestLag), confidence: round(Math.min(1, bestRaw), 2) };
}

/** Onsets per second: peaks of the flux envelope above its mean plus one deviation. */
function onsetRate(flux: Float64Array, sampleRate: number): number | null {
  if (flux.length < 3) return null;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  let v = 0;
  for (const f of flux) v += (f - mean) ** 2;
  const threshold = mean + Math.sqrt(v / flux.length);
  const minGap = Math.round((0.05 * sampleRate) / HOP);
  let count = 0;
  let last = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    if (
      flux[i] > threshold &&
      flux[i] >= flux[i - 1] &&
      flux[i] > flux[i + 1] &&
      i - last >= minGap
    ) {
      count++;
      last = i;
    }
  }
  return round(count / ((flux.length * HOP) / sampleRate), 2);
}

// -- the report ----------------------------------------------------------------

export function analyzeAudio(input: AudioInput, opts: { segments?: number } = {}): AudioReport {
  const chans = input.channels.slice(0, 2);
  const sr = input.sampleRate;
  const len = chans[0]?.length ?? 0;
  const durationSec = len / sr;

  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let clipped = 0;
  for (const ch of chans) {
    for (let i = 0; i < len; i++) {
      const s = ch[i];
      const a = Math.abs(s);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += s * s;
      sum += s;
    }
  }
  const total = len * chans.length || 1;
  const rms = Math.sqrt(sumSq / total);

  const sub = len ? subBlockEnergy(input, chans) : new Float64Array(0);
  const shortTerm = windows(sub, 30);

  const mono = monoMix(chans);
  const { meanPower, flux } = stft(mono);

  const segments = Math.max(1, Math.min(64, Math.floor(opts.segments ?? 16)));
  const timeline: TimelineSegment[] = [];
  const segLen = Math.max(1, Math.floor(len / segments));
  const step = Math.round(sr / 10);
  for (let s = 0; s < segments && s * segLen < len; s++) {
    const start = s * segLen;
    const end = s === segments - 1 ? len : Math.min(len, start + segLen);
    let p = 0;
    for (const ch of chans) for (let i = start; i < end; i++) p = Math.max(p, Math.abs(ch[i]));
    const b0 = Math.floor(start / step);
    const b1 = Math.max(b0 + 1, Math.floor(end / step));
    let e = 0;
    let n = 0;
    for (let b = b0; b < b1 && b < sub.length; b++, n++) e += sub[b];
    timeline.push({
      t: round(start / sr, 2),
      lufs: n && e > 0 ? finiteOrNull(blockLoudness(e / n)) : null,
      peakDb: p > 0 ? round(20 * Math.log10(p)) : null,
    });
  }

  // Silence by 50 ms blocks of the loudest channel.
  const blk = Math.max(1, Math.round(sr / 20));
  const blocks = Math.ceil(len / blk);
  const silent: boolean[] = [];
  for (let b = 0; b < blocks; b++) {
    let p = 0;
    for (const ch of chans) {
      for (let i = b * blk, end = Math.min(len, i + blk); i < end; i++)
        p = Math.max(p, Math.abs(ch[i]));
    }
    silent.push(p === 0 || 20 * Math.log10(p) < SILENCE_DB);
  }
  const lead = silent.findIndex((s) => !s);
  const trail = [...silent].reverse().findIndex((s) => !s);
  const blockSec = blk / sr;
  const silence = {
    leadingSec: round((lead === -1 ? blocks : lead) * blockSec, 2),
    trailingSec: round((trail === -1 ? 0 : trail) * blockSec, 2),
    silentPct: round((100 * silent.filter(Boolean).length) / (blocks || 1)),
  };

  let stereo: AudioReport['stereo'];
  if (chans.length === 2) {
    const [l, r] = chans;
    let lr = 0;
    let ll = 0;
    let rr = 0;
    let mid = 0;
    let side = 0;
    for (let i = 0; i < len; i++) {
      lr += l[i] * r[i];
      ll += l[i] * l[i];
      rr += r[i] * r[i];
      mid += ((l[i] + r[i]) / 2) ** 2;
      side += ((l[i] - r[i]) / 2) ** 2;
    }
    stereo = {
      correlation: ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 2) : 0,
      sideToMidDb: mid > 0 && side > 0 ? round(db(side / mid)) : null,
      balanceDb: ll > 0 && rr > 0 ? round(db(ll / rr)) : null,
    };
  }

  return {
    durationSec: round(durationSec, 2),
    channels: input.channels.length,
    sampleRate: sr,
    integratedLufs: finiteOrNull(integrated(windows(sub, 4))),
    shortTermMaxLufs: shortTerm.length ? finiteOrNull(blockLoudness(Math.max(...shortTerm))) : null,
    loudnessRangeLu: finiteOrNull(loudnessRange(shortTerm)),
    peakDb: peak > 0 ? round(20 * Math.log10(peak)) : null,
    rmsDb: rms > 0 ? round(20 * Math.log10(rms)) : null,
    crestDb: peak > 0 && rms > 0 ? round(20 * Math.log10(peak / rms)) : null,
    clippedSamples: clipped,
    dcOffset: round(sum / total, 4),
    silence,
    ...(stereo ? { stereo } : {}),
    bandsDb: bandShares(meanPower, sr),
    spectralCentroidHz: finiteOrNull(centroid(meanPower, sr), 0),
    timeline,
    tempo: estimateTempo(flux, sr),
    onsetsPerSec: onsetRate(flux, sr),
  };
}

/** Scalar fields worth a delta, in report order. */
const DELTA_KEYS = [
  'integratedLufs',
  'shortTermMaxLufs',
  'loudnessRangeLu',
  'peakDb',
  'rmsDb',
  'crestDb',
  'spectralCentroidHz',
] as const;

/**
 * B minus A for every scalar and band both reports carry — "what did my change do",
 * which is the question an A/B render is asked to answer.
 */
export function compareReports(a: AudioReport, b: AudioReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of DELTA_KEYS) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number' && typeof y === 'number')
      out[k] = round(y - x, k === 'spectralCentroidHz' ? 0 : 1);
  }
  for (const [name] of BANDS) {
    const x = a.bandsDb[name];
    const y = b.bandsDb[name];
    if (typeof x === 'number' && typeof y === 'number') out[`bandsDb.${name}`] = round(y - x);
  }
  return out;
}

/**
 * Log-frequency spectrogram over the mono mix, `cols` time columns by `rows` bands from
 * 30 Hz to Nyquist (capped at 20 kHz), plus the waveform's per-column extent. Each
 * column is the mean power of the frames that fall in it.
 */
export function spectrogram(input: AudioInput, cols = 800, rows = 160): Spectrogram {
  const chans = input.channels.slice(0, 2);
  const mono = monoMix(chans);
  const sr = input.sampleRate;
  const minHz = 30;
  const maxHz = Math.min(20000, sr / 2);
  const bins = FFT_SIZE / 2 + 1;
  const binHz = sr / FFT_SIZE;
  // Which row each FFT bin feeds; bins below 30 Hz feed none.
  const rowOf = new Int32Array(bins).fill(-1);
  const logMin = Math.log(minHz);
  const logSpan = Math.log(maxHz) - logMin;
  for (let k = 0; k < bins; k++) {
    const hz = k * binHz;
    if (hz < minHz || hz > maxHz) continue;
    rowOf[k] = Math.min(rows - 1, Math.floor(((Math.log(hz) - logMin) / logSpan) * rows));
  }
  const totalFrames = mono.length >= FFT_SIZE ? Math.floor((mono.length - FFT_SIZE) / HOP) + 1 : 0;
  const acc = new Float64Array(cols * rows);
  const counts = new Float64Array(cols);
  stft(mono, (f, power) => {
    const c = Math.min(cols - 1, Math.floor((f / Math.max(1, totalFrames)) * cols));
    counts[c]++;
    for (let k = 0; k < bins; k++) {
      const r = rowOf[k];
      if (r >= 0) acc[r * cols + c] += power[k];
    }
  });
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = counts[c] ? acc[r * cols + c] / counts[c] : 0;
      out[r * cols + c] = v > 0 ? 10 * Math.log10(v) : -150;
    }
  }
  // A row narrower than one bin (the bottom octaves) gets no bin of its own; borrow the
  // nearest row below that has one, so the low end is not drawn as black stripes.
  for (let r = 1; r < rows; r++) {
    let empty = true;
    for (let k = 0; k < bins && empty; k++) if (rowOf[k] === r) empty = false;
    if (empty) out.copyWithin(r * cols, (r - 1) * cols, r * cols);
  }
  const waveMin = new Float32Array(cols);
  const waveMax = new Float32Array(cols);
  const per = mono.length / cols;
  for (let c = 0; c < cols; c++) {
    let lo = 0;
    let hi = 0;
    for (
      let i = Math.floor(c * per), end = Math.min(mono.length, Math.floor((c + 1) * per));
      i < end;
      i++
    ) {
      if (mono[i] < lo) lo = mono[i];
      if (mono[i] > hi) hi = mono[i];
    }
    waveMin[c] = lo;
    waveMax[c] = hi;
  }
  return { cols, rows, minHz, maxHz, db: out, waveMin, waveMax };
}
