/**
 * Types for the action reload cache system.
 *
 * Caches AI-generated action sequences and replays them instantly
 * when similar contexts reappear.
 */

import type { OSAction } from '@yaar/shared';

export interface Fingerprint {
  triggerType: 'main' | 'window';
  triggerTarget?: string; // windowId for window tasks
  ngrams: string[]; // Word n-grams from normalized content
  contentHash: string; // SHA-256 for exact match fast path
  windowStateHash: string; // Hash of sorted window IDs + renderers
}

export interface CacheEntry {
  id: string;
  fingerprint: Fingerprint;
  fingerprintKey: string; // contentHash+windowStateHash for O(1) lookup
  actions: OSAction[];
  label: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  failureCount: number;
  requiredWindowIds?: string[]; // Windows that must exist for valid replay
}

export interface CacheMatch {
  entry: CacheEntry;
  similarity: number; // 0-1
  isExact: boolean;
}
