// Boundary schemas for untrusted external ML JSON: the server-side ML-weights
// download job status (`/api/ml-weights/download`) and the model config file
// (`webgpu/latent_stats.json`) streamed from Hugging Face. These validate ONLY
// the fields the app reads, and use looseObject so additive upstream fields
// survive. A parse failure means the route/config returned something we can't
// interpret; the caller turns that into a concise error, full issues in console.
// This is a trust-boundary check, not a second copy of the domain types.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod ~260KB.
import * as z from '@bundled/zod';

/**
 * One response from `POST /api/ml-weights/download` (start) or its `GET` poll.
 * `download.ts` reads `state` (drives the poll loop), `loaded`/`total` (progress),
 * and `error` (surfaced on failure). Loose so the server may add fields freely.
 */
export const JobStatusSchema = z.looseObject({
  state: z.enum(['idle', 'downloading', 'done', 'error']),
  loaded: z.number(),
  total: z.number(),
  error: z.optional(z.string()),
});

/**
 * `webgpu/latent_stats.json` — per-channel denorm stats + sigma schedule dumped by
 * the Python export. `generate.ts` reads `z` (channel count), `sigmas` (scheduler),
 * and `latents_mean`/`latents_std` (denorm). `size` exists upstream but is
 * deliberately unused (the latent grid comes from the aspect-ratio bucket), so it
 * is not validated. Loose keeps it and any other extra fields.
 */
export const LatentStatsSchema = z.looseObject({
  latents_mean: z.array(z.number()),
  latents_std: z.array(z.number()),
  sigmas: z.array(z.number()),
  z: z.number(),
});

export type LatentStats = z.infer<typeof LatentStatsSchema>;
