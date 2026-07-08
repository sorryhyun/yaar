// ER-SDE sampler (VP ER-SDE-Solver-3, arXiv:2309.06169) for the flow-matching
// Anima DiT — a faithful JS port of `er_sde_scheduler.py` (AnimaErSDEScheduler).
//
// The Python scheduler subclasses FlowMatchEulerDiscrete and overrides only
// step(). We port step() plus the sigma/alpha/lambda tables. The ComfyUI "simple"
// sigma schedule is precomputed on the Python side (dumped in latent_stats.json as
// `sigmas`), so we take those directly rather than re-deriving them from `shift`.
//
// All latent math is elementwise over a Float32Array; every ER coefficient
// (r, r_alpha, dt, s, s_u, coeff) is a scalar per step, so a step is just a handful
// of `a*x + b*y` sweeps.

const NUM_INTEGRATION_POINTS = 200;

// ComfyUI default noise scaler: nu(x) = x * (exp(x^0.3) + 10)
function noiseScaler(x: number): number {
  return x * (Math.exp(Math.pow(x, 0.3)) + 10.0);
}

// ── seedable Gaussian RNG (mulberry32 + Box–Muller) ──────────────────────────
// torch's Mersenne-Twister randn can't be matched bit-for-bit in JS, so the
// rendered sample differs from the Python golden pixel-wise — but it's the same
// distribution, so the image is an equally-valid draw of the same prompt.
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fill `out` with standard-normal samples via Box–Muller from a uniform rng. */
export function randn(out: Float32Array, rng: () => number): Float32Array {
  for (let i = 0; i < out.length; i += 2) {
    const u1 = rng() || 1e-9;
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

export class ErSDEScheduler {
  readonly sigmas: number[]; // length steps+1, ends at 0
  private erAlphas: number[];
  private erLambdas: number[];
  private oldDenoised: Float32Array | null = null;
  private oldDenoisedD: Float32Array | null = null;
  private stepIndex = 0;
  private readonly maxStage = 3;
  private readonly sNoise = 1.0;
  private rng: () => number;

  /** @param sigmas the `sigmas` array from latent_stats.json (e.g. [1.0,0.9,0.75,0.5]);
   *  a trailing 0 is appended if absent. */
  constructor(sigmas: number[], seed = 0) {
    this.sigmas = sigmas[sigmas.length - 1] === 0 ? sigmas.slice() : [...sigmas, 0.0];
    // Offset only the first sigma so er_lambda is finite at sigma>=1
    // (mirrors ComfyUI offset_first_sigma_for_snr / the Python clamp).
    const sig = this.sigmas.map((s, i) => (i === 0 ? Math.min(s, 1.0 - 1e-4) : s));
    this.erAlphas = sig.map((s) => 1.0 - s); // alpha_t = 1 - sigma
    this.erLambdas = sig.map((s) => s / Math.max(1.0 - s, 1e-8)); // sigma/(1-sigma)
    this.rng = makeRng(seed);
  }

  get numSteps(): number {
    return this.sigmas.length - 1;
  }

  /** timestep fed to the DiT at step i: sigma_i (normalized, == t/num_train_timesteps). */
  timestepSigma(i: number): number {
    return this.sigmas[i];
  }

  /** One ER-SDE step. `sample` and `modelOutput` are latents (Float32Array, same
   *  length); returns the next latent. Mutates internal history. */
  step(modelOutput: Float32Array, sample: Float32Array): Float32Array {
    const i = this.stepIndex;
    const n = sample.length;
    const sigmaS = this.sigmas[i];
    const sigmaT = this.sigmas[i + 1];

    // denoised = sample - sigma_s * model_output   (x0 estimate, flow matching)
    const denoised = new Float32Array(n);
    for (let k = 0; k < n; k++) denoised[k] = sample[k] - sigmaS * modelOutput[k];

    let x: Float32Array;
    if (sigmaT === 0.0) {
      x = denoised.slice();
    } else {
      const erLambdaS = this.erLambdas[i];
      const erLambdaT = this.erLambdas[i + 1];
      const alphaS = this.erAlphas[i];
      const alphaT = this.erAlphas[i + 1];
      const rAlpha = alphaT / alphaS;
      const r = noiseScaler(erLambdaT) / noiseScaler(erLambdaS);

      // Stage 1 (Euler): x = r_alpha*r*sample + alpha_t*(1-r)*denoised
      const c1 = rAlpha * r;
      const c2 = alphaT * (1.0 - r);
      x = new Float32Array(n);
      for (let k = 0; k < n; k++) x[k] = c1 * sample[k] + c2 * denoised[k];

      const stageUsed = Math.min(this.maxStage, i + 1);
      if (stageUsed >= 2 && this.oldDenoised) {
        const dt = erLambdaT - erLambdaS;
        const lamStep = -dt / NUM_INTEGRATION_POINTS;
        let s = 0;
        let sU = 0;
        for (let idx = 0; idx < NUM_INTEGRATION_POINTS; idx++) {
          const lamPos = erLambdaT + idx * lamStep;
          const scaled = noiseScaler(lamPos);
          s += 1.0 / scaled;
          sU += (lamPos - erLambdaS) / scaled;
        }
        s *= lamStep;
        sU *= lamStep;

        // denoised_d = (denoised - old_denoised) / (er_lambda_s - er_lambda_{i-1})
        const denomD = erLambdaS - this.erLambdas[i - 1];
        const denoisedD = new Float32Array(n);
        for (let k = 0; k < n; k++) denoisedD[k] = (denoised[k] - this.oldDenoised[k]) / denomD;

        const c3 = alphaT * (dt + s * noiseScaler(erLambdaT));
        for (let k = 0; k < n; k++) x[k] += c3 * denoisedD[k];

        if (stageUsed >= 3 && this.oldDenoisedD) {
          // denoised_u = (denoised_d - old_denoised_d) / ((er_lambda_s - er_lambda_{i-2})/2)
          const denomU = (erLambdaS - this.erLambdas[i - 2]) / 2.0;
          const c4 = alphaT * ((dt * dt) / 2.0 + sU * noiseScaler(erLambdaT));
          for (let k = 0; k < n; k++) {
            const denoisedU = (denoisedD[k] - this.oldDenoisedD[k]) / denomU;
            x[k] += c4 * denoisedU;
          }
        }
        this.oldDenoisedD = denoisedD;
      }

      if (this.sNoise > 0) {
        // coeff = sqrt(max(er_lambda_t^2 - er_lambda_s^2 * r^2, 0))
        const coeff = Math.sqrt(Math.max(erLambdaT * erLambdaT - erLambdaS * erLambdaS * r * r, 0));
        const noise = randn(new Float32Array(n), this.rng);
        const cn = alphaT * this.sNoise * coeff;
        for (let k = 0; k < n; k++) x[k] += cn * noise[k];
      }
    }

    this.oldDenoised = denoised;
    this.stepIndex += 1;
    return x;
  }
}
