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
  // MCP tool handlers run outside agentContext (AsyncLocalStorage) so they
  // can't resolve the real connection ID. Track the most-recently-loaded
  // cache so `get('global')` can fall back to it.
  private activeCache: ReloadCache | null = null;

  get(connectionId: ConnectionId): ReloadCache {
    let cache = this.caches.get(connectionId);
    if (!cache) {
      // Fallback: MCP tools resolve to 'global' because AsyncLocalStorage
      // isn't available in HTTP request context. Return the active cache.
      if (connectionId === 'global' && this.activeCache) {
        return this.activeCache;
      }
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
    this.activeCache = cache;
    return cache;
  }

  clear(connectionId: ConnectionId): void {
    if (this.activeCache === this.caches.get(connectionId)) {
      this.activeCache = null;
    }
    this.caches.delete(connectionId);
    this.loading.delete(connectionId);
  }

  clearAll(): void {
    this.activeCache = null;
    this.caches.clear();
    this.loading.clear();
  }
}

export const reloadCacheManager = new ReloadCacheManager();
