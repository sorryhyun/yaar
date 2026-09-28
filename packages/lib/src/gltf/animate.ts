/**
 * Animation samplers evaluated the way a glTF loader plays them: a value at any time, not
 * only at the keys.
 *
 * This is what lets a summary answer "where is the magazine 0.4 s into Reload" — in world
 * space, with an animated parent — without anyone building the app and reading its runtime
 * state. The rules are the spec's: before the first key the first value holds, after the
 * last the last does; LINEAR rotations slerp, CUBICSPLINE is the Hermite form with tangents
 * scaled by the key interval, STEP holds each value until the next key.
 */

import type { AccessorData } from './accessor.js';
import { normalizeQuat, slerp } from './matrix.js';

/**
 * Two keys closer than this are one instantaneous change (a hide by scale 0.001, a snap to a
 * new grip), not motion — an eighth of a 60 fps frame, which no player can show as a blend.
 */
export const JUMP_SECONDS = 0.002;

export interface Track {
  times: Float64Array;
  keys: number;
  /** Numbers per value: 3 for translation/scale, 4 for rotation, the target count for weights. */
  width: number;
  interpolation: string;
  /** The keyed value at key `k` (for CUBICSPLINE, the value between its two tangents). */
  value(k: number): number[];
  /** The value at time `t`, interpolated as a loader would. */
  sample(t: number): number[];
}

export function decodeTrack(
  input: AccessorData,
  output: AccessorData,
  interpolation: string,
  path: string,
): Track {
  const keys = input.count;
  const times = input.values;
  const cubic = interpolation === 'CUBICSPLINE';
  const stride = cubic ? 3 : 1;
  const width = keys ? (output.count * output.itemSize) / keys / stride : 0;
  const out = output.values;
  const at = (k: number, part: 0 | 1 | 2) => {
    const start = (k * stride + (cubic ? part : 0)) * width;
    return Array.from(out.subarray(start, start + width));
  };
  const value = (k: number) => at(k, 1);
  const rotation = path === 'rotation' && width === 4;

  const sample = (t: number): number[] => {
    if (keys === 0) return [];
    if (keys === 1 || t <= times[0]) return value(0);
    if (t >= times[keys - 1]) return value(keys - 1);
    // Last key at or before t.
    let lo = 0;
    let hi = keys - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const dt = times[hi] - times[lo];
    if (interpolation === 'STEP' || dt <= 0) return value(lo);
    const s = (t - times[lo]) / dt;
    if (cubic) {
      const s2 = s * s;
      const s3 = s2 * s;
      const v0 = value(lo);
      const b0 = at(lo, 2); // out-tangent
      const v1 = value(hi);
      const a1 = at(hi, 0); // in-tangent
      const r = v0.map(
        (_, j) =>
          (2 * s3 - 3 * s2 + 1) * v0[j] +
          (s3 - 2 * s2 + s) * dt * b0[j] +
          (-2 * s3 + 3 * s2) * v1[j] +
          (s3 - s2) * dt * a1[j],
      );
      return rotation ? normalizeQuat(r) : r;
    }
    if (rotation) return slerp(value(lo), value(hi), s);
    const v0 = value(lo);
    const v1 = value(hi);
    return v0.map((x, j) => x + (v1[j] - x) * s);
  };

  return { times, keys, width, interpolation, value, sample };
}

export interface Jump {
  /** Time of the key the change starts from. */
  at: number;
  /** Seconds between the two keys. */
  dt: number;
  /** The value it jumps from, and the value it jumps to. */
  from: number[];
  to: number[];
}

/** Changes that happen between two keys closer than `JUMP_SECONDS` — invisible as motion. */
export function findJumps(track: Track): Jump[] {
  const jumps: Jump[] = [];
  for (let k = 1; k < track.keys; k++) {
    const dt = track.times[k] - track.times[k - 1];
    if (dt >= JUMP_SECONDS) continue;
    const a = track.value(k - 1);
    const b = track.value(k);
    if (a.some((v, j) => Math.abs(v - b[j]) > 1e-4))
      jumps.push({ at: track.times[k - 1], dt, from: a, to: b });
  }
  return jumps;
}

/** Times from `from` to `to` every `step`, ending exactly on `to`. */
export function sampleTimes(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.floor((to - from) / step + 1e-9);
  for (let i = 0; i <= n; i++) out.push(from + i * step);
  if (to - out[out.length - 1] > 1e-9) out.push(to);
  return out;
}

/**
 * Keep a run of Euler angles continuous: each angle moves by whole turns to sit within 180°
 * of the row before, so a clip turning through 180° reads 170, 190 rather than 170, -170.
 */
export function unwrapDegrees(rows: number[][], from: number, count: number): void {
  for (let r = 1; r < rows.length; r++) {
    for (let j = from; j < from + count; j++) {
      const prev = rows[r - 1][j];
      let v = rows[r][j];
      while (v - prev > 180) v -= 360;
      while (v - prev < -180) v += 360;
      rows[r][j] = v;
    }
  }
}
