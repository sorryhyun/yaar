export type EasingFn = (t: number) => number;

export const Easing = {
  linear: (t: number) => t,
  easeIn: (t: number) => t * t,
  easeOut: (t: number) => 1 - (1 - t) * (1 - t),
  easeInOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  bounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  elastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
  },
} as const;

interface InterpolateOptions {
  easing?: EasingFn;
  extrapolateLeft?: 'clamp' | 'extend';
  extrapolateRight?: 'clamp' | 'extend';
}

export function interpolate(
  value: number,
  inputRange: number[],
  outputRange: number[],
  options?: InterpolateOptions,
): number {
  const { easing = Easing.linear, extrapolateLeft = 'clamp', extrapolateRight = 'clamp' } =
    options ?? {};

  if (inputRange.length < 2 || outputRange.length < 2) {
    return outputRange[0] ?? 0;
  }

  // Clamp input if needed
  const minIn = inputRange[0];
  const maxIn = inputRange[inputRange.length - 1];

  if (value <= minIn) {
    if (extrapolateLeft === 'clamp') return outputRange[0];
  }
  if (value >= maxIn) {
    if (extrapolateRight === 'clamp') return outputRange[outputRange.length - 1];
  }

  // Find the segment
  let segIdx = 0;
  for (let i = 1; i < inputRange.length; i++) {
    if (value <= inputRange[i]) {
      segIdx = i - 1;
      break;
    }
    segIdx = i - 1;
  }

  const inStart = inputRange[segIdx];
  const inEnd = inputRange[segIdx + 1];
  const outStart = outputRange[segIdx];
  const outEnd = outputRange[segIdx + 1];

  const rawProgress = inEnd === inStart ? 0 : (value - inStart) / (inEnd - inStart);
  const easedProgress = easing(Math.max(0, Math.min(1, rawProgress)));

  return outStart + (outEnd - outStart) * easedProgress;
}

interface SpringConfig {
  frame: number;
  fps: number;
  damping?: number;
  stiffness?: number;
  mass?: number;
}

export function spring(config: SpringConfig): number {
  const { frame, fps, damping = 10, stiffness = 100, mass = 1 } = config;
  const t = frame / fps;

  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta >= 1) {
    // Overdamped or critically damped
    const r = -omega * zeta;
    return 1 - Math.exp(r * t) * (1 - r * t);
  }

  // Underdamped
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + (zeta * omega / omegaD) * Math.sin(omegaD * t));
}
