/**
 * Action reload cache module.
 *
 * Exports types, cache, fingerprinting, and a singleton instance.
 */

import { join } from 'path';
import { getConfigDir } from '../storage/storage-manager.js';
import { ReloadCache } from './cache.js';

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
/**
 * Singleton reload cache instance.
 */
export const reloadCache = new ReloadCache(join(getConfigDir(), 'reload-cache.json'));
