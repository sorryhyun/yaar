// Console logging, the on-screen progress bar bridge, and the numeric summaries the
// pipeline/diagnostics print. No pipeline logic lives here.
import { app as yaarApp } from '@bundled/yaar';
import { asF32, type Progress } from './ml';
import { busy, setProgress } from './state';

export function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log('[anima]', msg);
}

/** Set the on-screen progress bar (and mirror the label to the console). */
export function phase(label: string, pct: number | null = null): void {
  setProgress({ label, pct });
  log(label);
}

export const mb = (n: number) => (n / 1024 / 1024).toFixed(0) + ' MB';
export const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';

let _lastPct = -1;
/** Weight-download progress callback handed to loadModel/promptEmbeds. */
export function onProg(p: Progress): void {
  const name = p.file.split('/').pop() ?? p.file;
  if (p.cached) {
    setProgress({ label: `${name} (cached)`, pct: 100 });
    yaarApp?.emit('progress', { label: `${name} (cached)`, pct: 100, busy: busy() });
    return log(`  ${p.file}: cached (${mb(p.loaded)})`);
  }
  const pct = Math.floor(p.ratio * 100);
  setProgress({ label: `Loading ${name}`, pct: p.total ? pct : null });
  yaarApp?.emit('progress', { label: `Loading ${name}`, pct: p.total ? pct : null, busy: busy() });
  if (pct !== _lastPct && pct % 5 === 0) {
    _lastPct = pct;
    log(`  ${p.file}: ${pct}% (${mb(p.loaded)}${p.total ? ' / ' + mb(p.total) : ''})`);
  }
}

export function stats(a: Float32Array): { min: number; max: number; mean: number; nan: number } {
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    nan = 0;
  for (const v of a) {
    if (Number.isNaN(v)) nan++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  return { min, max, mean: sum / a.length, nan };
}

// Type-aware stats over an ORT tensor. `asF32` handles float32, Float16Array and
// raw-fp16 Uint16Array alike — don't bit-decode by hand, see ml.ts.
export function tensorStats(t: { data: unknown; type: string }): {
  min: number;
  max: number;
  nan: number;
  inf: number;
  n: number;
} {
  const raw = asF32(t);
  let min = Infinity,
    max = -Infinity,
    nan = 0,
    inf = 0;
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (Number.isNaN(v)) nan++;
    else if (!Number.isFinite(v)) inf++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max, nan, inf, n };
}
