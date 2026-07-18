// ORT session policy for the DiT: which graph optimizations a given export tolerates,
// and how to evict the sessions belonging to other exports/ratios.
//
// The DiT is `dit_<W>x<H>_fp16_r16`: fp16 with the residual stream rescaled ×1/16
// (folded into patch-embed + branch out-projections — an exact invariance), which
// keeps activations inside fp16's 65504 ceiling (peak ~1.66e4) so WebGPU graph
// optimizations stay ENABLED. See ../krea/scripts/rescale_dit_residual.py.
import { releaseModels } from '../ml';
import { DEFAULT_BUCKET } from '../buckets';

/** The DiT the diagnostics (ditGate/ditProbe) run against. The other exports the
 *  header used to describe — plain fp16 (all-NaN on WebGPU) and the fp32-activation
 *  `_webgpu` build — were only ever 512² and are no longer published, so r16 is the
 *  one DiT: every ratio ships exactly one graph. */
export const DIT_512 = DEFAULT_BUCKET.dit;

// Session options per DiT export. The cast-hack exports NEED graph opt disabled
// (constant folding would materialise the fp32 weights); the rescaled export runs
// with full optimizations — that's its whole point.
export function ditSessionOptions(model: string, graphOpt?: string): Record<string, unknown> {
  if (graphOpt) return { graphOptimizationLevel: graphOpt };
  return model.includes('_r16') ? {} : { graphOptimizationLevel: 'disabled' };
}

/** Free GPU/wasm memory held by DiT sessions other than `keep` (sessions are
 *  memoized in loadModel — see ml.ts — so an old variant would stay resident). */
export function releaseOtherDits(keep?: string): Promise<void> {
  return releaseModels((n) => n.startsWith('dit_') && n !== keep);
}
