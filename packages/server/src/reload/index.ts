/**
 * Action reload cache module.
 *
 * Exports types, cache, and fingerprinting.
 * Cache instances are owned by LiveSession (no longer managed by a singleton).
 */

export type { Fingerprint, CacheEntry, CacheMatch } from './types.js';
export { ReloadCache } from './cache.js';
export {
  normalizeContent,
  computeNgrams,
  jaccardSimilarity,
  computeContentHash,
  computeWindowStateHash,
  computeFingerprint,
  computeSimilarity,
} from './fingerprint.js';
