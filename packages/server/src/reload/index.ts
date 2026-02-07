/**
 * Action reload cache module.
 *
 * Exports types, cache, fingerprinting, and cache manager.
 */

import { join } from 'path';
import { getConfigDir } from '../storage/storage-manager.js';
import type { ConnectionId } from '../websocket/broadcast-center.js';
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

class ReloadCacheManager {
  private caches = new Map<ConnectionId, ReloadCache>();
  private loading = new Map<ConnectionId, Promise<void>>();

  get(connectionId: ConnectionId): ReloadCache {
    let cache = this.caches.get(connectionId);
    if (!cache) {
      const filePath = join(getConfigDir(), 'reload-cache', `${connectionId}.json`);
      cache = new ReloadCache(filePath);
      this.caches.set(connectionId, cache);
    }
    return cache;
  }

  async ensureLoaded(connectionId: ConnectionId): Promise<ReloadCache> {
    const cache = this.get(connectionId);
    let loadPromise = this.loading.get(connectionId);
    if (!loadPromise) {
      loadPromise = cache.load().then(() => undefined);
      this.loading.set(connectionId, loadPromise);
    }
    await loadPromise;
    return cache;
  }

  clear(connectionId: ConnectionId): void {
    this.caches.delete(connectionId);
    this.loading.delete(connectionId);
  }

  clearAll(): void {
    this.caches.clear();
    this.loading.clear();
  }
}

export const reloadCacheManager = new ReloadCacheManager();
