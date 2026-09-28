/**
 * 4×4 column-major matrices, as glTF stores them — just enough to place a node in the world
 * and to turn a `matrix` node back into the TRS a reader expects.
 */

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function fromArray(values: ArrayLike<number>, offset = 0): Mat4 {
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i++) m[i] = values[offset + i] ?? 0;
  return m;
}

export function compose(t: Vec3, r: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = r;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * s[0];
  m[1] = (xy + wz) * s[0];
  m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1];
  m[5] = (1 - (xx + zz)) * s[1];
  m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2];
  m[9] = (yz - wx) * s[2];
  m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/** `a × b` — `b` applied first. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Split an affine matrix into translation, rotation and scale (a mirror lands on x). */
export function decompose(m: Mat4): { t: Vec3; r: Quat; s: Vec3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) sx = -sx;
  const r = quatFromRotation(
    m[0] / sx,
    m[4] / sy,
    m[8] / sz,
    m[1] / sx,
    m[5] / sy,
    m[9] / sz,
    m[2] / sx,
    m[6] / sy,
    m[10] / sz,
  );
  return { t: [m[12], m[13], m[14]], r, s: [sx, sy, sz] };
}

function quatFromRotation(
  m11: number,
  m12: number,
  m13: number,
  m21: number,
  m22: number,
  m23: number,
  m31: number,
  m32: number,
  m33: number,
): Quat {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** Angle in degrees between two unit quaternions (the rotation taking one to the other). */
export function quatAngleDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** The world-space box around a local box's 8 corners under `m`. */
export function transformBox(m: Mat4, min: Vec3, max: Vec3): { min: Vec3; max: Vec3 } {
  const outMin: Vec3 = [Infinity, Infinity, Infinity];
  const outMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = transformPoint(m, [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]);
    for (let k = 0; k < 3; k++) {
      outMin[k] = Math.min(outMin[k], p[k]);
      outMax[k] = Math.max(outMax[k], p[k]);
    }
  }
  return { min: outMin, max: outMax };
}

/** A unit quaternion as XYZ Euler angles in degrees — three.js's default order. */
export function quatToEulerDeg(q: ArrayLike<number>): Vec3 {
  const m = compose([0, 0, 0], [q[0], q[1], q[2], q[3]], [1, 1, 1]);
  // Row-major names over the column-major array: m13 is row 1, column 3.
  const m11 = m[0],
    m12 = m[4],
    m13 = m[8];
  const m22 = m[5],
    m23 = m[9];
  const m32 = m[6],
    m33 = m[10];
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  const [x, z] =
    Math.abs(m13) < 0.9999999
      ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)]
      : [Math.atan2(m32, m22), 0];
  const deg = 180 / Math.PI;
  return [x * deg, y * deg, z * deg];
}

/** Spherical interpolation along the shorter arc; the result is normalized. */
export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, s: number): Quat {
  let [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    [bx, by, bz, bw] = [-bx, -by, -bz, -bw];
    dot = -dot;
  }
  let wa = 1 - s;
  let wb = s;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot));
    const sin = Math.sin(theta);
    wa = Math.sin((1 - s) * theta) / sin;
    wb = Math.sin(s * theta) / sin;
  }
  return normalizeQuat([
    wa * a[0] + wb * bx,
    wa * a[1] + wb * by,
    wa * a[2] + wb * bz,
    wa * a[3] + wb * bw,
  ]);
}

export function normalizeQuat(q: ArrayLike<number>): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Whether two affine matrices place things the same, to within float32 noise. */
export function sameMatrix(a: Mat4, b: Mat4, eps = 1e-6): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}
