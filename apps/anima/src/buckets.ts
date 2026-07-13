// Aspect-ratio buckets.
//
// The DiT graph is exported at a FIXED resolution — Cosmos RoPE tables and the
// padding mask constant-fold into the graph, which is the only reason it exports at
// all (see ../../krea/scripts/export_onnx_dit.py). So a ratio is a graph, not a
// runtime parameter. What a ratio is NOT is a copy of the weights: every bucket's
// graph is re-pointed at the ONE 3.9 GB sidecar by share_sidecar.py, so a bucket
// costs ~9 MB and switching ratio re-uses weights already on disk.
//
// Two hard constraints on the numbers:
//   * dims must be multiples of 16 — the VAE compresses 8x, then the DiT patchifies
//     2x, so an image dim of 16k gives a latent 2k and a patch grid k.
//   * attention is O(tokens²) and tokens = (W/16)·(H/16). 512² is 1024 tokens with
//     3.9 GB of weights already near the GPU budget, so every bucket is sized to
//     ~1024 tokens. A "bigger" ratio here means wider, not more pixels.

export interface Bucket {
  id: string;
  label: string;
  /** Image dims. Latent grid is /8, patch grid (== attention tokens) is /16. */
  W: number;
  H: number;
  /** DiT graph for this ratio (weights come from SHARED_DIT_DATA). */
  dit: string;
  /** VAE decoder graph for this ratio (weights come from SHARED_VAE_DATA). */
  vae: string;
}

/** The one weight sidecar every DiT bucket shares. Named for the 512 export that
 *  produced it — bucket graphs point at this exact file, so an existing install
 *  gains new ratios without re-downloading 3.9 GB. */
export const SHARED_DIT_DATA = 'dit_512_fp16_r16.onnx.data';
export const SHARED_VAE_DATA = 'vae_decoder_512_fp16.onnx.data';

export const BUCKETS: Bucket[] = [
  {
    id: '512x512',
    label: '1:1 · 512×512',
    W: 512,
    H: 512,
    dit: 'dit_512_fp16_r16',
    vae: 'vae_decoder_512_fp16',
  },
  {
    id: '624x416',
    label: '3:2 · 624×416',
    W: 624,
    H: 416,
    dit: 'dit_624x416_fp16_r16',
    vae: 'vae_decoder_624x416_fp16',
  },
  {
    id: '416x624',
    label: '2:3 · 416×624',
    W: 416,
    H: 624,
    dit: 'dit_416x624_fp16_r16',
    vae: 'vae_decoder_416x624_fp16',
  },
  {
    id: '688x384',
    label: '16:9 · 688×384',
    W: 688,
    H: 384,
    dit: 'dit_688x384_fp16_r16',
    vae: 'vae_decoder_688x384_fp16',
  },
  {
    id: '384x688',
    label: '9:16 · 384×688',
    W: 384,
    H: 688,
    dit: 'dit_384x688_fp16_r16',
    vae: 'vae_decoder_384x688_fp16',
  },
];

export const DEFAULT_BUCKET = BUCKETS[0];

export const bucketById = (id: string): Bucket =>
  BUCKETS.find((b) => b.id === id) ?? DEFAULT_BUCKET;

/** Latent grid (VAE 8x compression) — the DiT's spatial dims. */
export const latentDims = (b: Bucket) => ({ lh: b.H / 8, lw: b.W / 8 });

/** Attention tokens, for the record: (W/16)·(H/16). */
export const tokens = (b: Bucket) => (b.W / 16) * (b.H / 16);
