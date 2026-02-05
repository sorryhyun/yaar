/**
 * ReloadCache - Persistent cache for AI-generated action sequences.
 *
 * Stores fingerprinted action sequences on disk and provides
 * exact (O(1)) and fuzzy (O(n)) matching for cache lookups.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { OSAction } from '@yaar/shared';
import type { CacheEntry, CacheMatch, Fingerprint } from './types.js';
import { computeSimilarity } from './fingerprint.js';

const MAX_ENTRIES = 100;
const MIN_SIMILARITY = 0.7;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SAVE_DEBOUNCE_MS = 500;

export class ReloadCache {
  private filePath: string;
  private exactMap: Map<string, CacheEntry> = new Map();
  private entries: CacheEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private idCounter = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load cache from disk.
   */
  async load(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data) as { entries: CacheEntry[]; idCounter?: number };
      this.entries = parsed.entries ?? [];
      this.idCounter = parsed.idCounter ?? this.entries.length;

      // Rebuild exact lookup map
      this.exactMap.clear();
      for (const entry of this.entries) {
        this.exactMap.set(entry.fingerprintKey, entry);
      }

      console.log(`[ReloadCache] Loaded ${this.entries.length} entries from disk`);
    } catch {
      // File doesn't exist or is invalid - start fresh
      this.entries = [];
      this.exactMap.clear();
      console.log('[ReloadCache] No existing cache found, starting fresh');
    }
  }

  /**
   * Save cache to disk (debounced).
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk().catch(err => {
        console.error('[ReloadCache] Failed to save:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const data = JSON.stringify({ entries: this.entries, idCounter: this.idCounter }, null, 2);
      await writeFile(this.filePath, data, 'utf-8');
    } catch (err) {
      console.error('[ReloadCache] Failed to write cache file:', err);
    }
  }

  /**
   * Record an action sequence for a fingerprint.
   * Upserts: if an exact match already exists, updates it.
   */
  record(
    fingerprint: Fingerprint,
    actions: OSAction[],
    label: string,
    opts?: { requiredWindowIds?: string[] }
  ): CacheEntry {
    const fingerprintKey = `${fingerprint.contentHash}:${fingerprint.windowStateHash}`;
    const existing = this.exactMap.get(fingerprintKey);

    if (existing) {
      // Update existing entry with fresh actions
      existing.actions = actions;
      existing.label = label;
      existing.lastUsedAt = Date.now();
      existing.requiredWindowIds = opts?.requiredWindowIds;
      this.scheduleSave();
      console.log(`[ReloadCache] Updated existing entry "${label}" (${existing.id})`);
      return existing;
    }

    // Create new entry
    const entry: CacheEntry = {
      id: `reload-${++this.idCounter}`,
      fingerprint,
      fingerprintKey,
      actions,
      label,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
      failureCount: 0,
      requiredWindowIds: opts?.requiredWindowIds,
    };

    this.entries.push(entry);
    this.exactMap.set(fingerprintKey, entry);

    // Evict if over capacity
    this.evict();
    this.scheduleSave();

    console.log(`[ReloadCache] Recorded new entry "${label}" (${entry.id}), total: ${this.entries.length}`);
    return entry;
  }

  /**
   * Find matching cache entries for a fingerprint.
   * Exact match first (O(1)), then similarity scan (O(n)).
   */
  findMatches(fingerprint: Fingerprint, limit: number = 3): CacheMatch[] {
    const fingerprintKey = `${fingerprint.contentHash}:${fingerprint.windowStateHash}`;
    const matches: CacheMatch[] = [];

    // Exact match fast path
    const exact = this.exactMap.get(fingerprintKey);
    if (exact) {
      matches.push({ entry: exact, similarity: 1.0, isExact: true });
      if (matches.length >= limit) return matches;
    }

    // Similarity scan for fuzzy matches
    for (const entry of this.entries) {
      if (exact && entry.id === exact.id) continue; // Already added

      const similarity = computeSimilarity(fingerprint, entry.fingerprint);
      if (similarity >= MIN_SIMILARITY) {
        matches.push({ entry, similarity, isExact: false });
      }
    }

    // Sort by similarity descending, take top N
    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, limit);
  }

  /**
   * List all entries (for tools listing).
   */
  listEntries(): CacheEntry[] {
    return [...this.entries];
  }

  /**
   * Get an entry by ID.
   */
  getEntry(id: string): CacheEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  /**
   * Mark an entry as successfully used.
   */
  markUsed(id: string): void {
    const entry = this.getEntry(id);
    if (entry) {
      entry.useCount++;
      entry.lastUsedAt = Date.now();
      this.scheduleSave();
    }
  }

  /**
   * Mark an entry as failed. Remove if failure rate > 50% with min 3 uses.
   */
  markFailed(id: string): void {
    const entry = this.getEntry(id);
    if (!entry) return;

    entry.failureCount++;
    const totalAttempts = entry.useCount + entry.failureCount;
    if (totalAttempts >= 3 && entry.failureCount / totalAttempts > 0.5) {
      this.removeEntry(id);
      console.log(`[ReloadCache] Removed entry "${entry.label}" due to high failure rate`);
    } else {
      this.scheduleSave();
    }
  }

  /**
   * Invalidate entries that depend on a specific window.
   */
  invalidateForWindow(windowId: string): void {
    const toRemove = this.entries.filter(
      e => e.requiredWindowIds?.includes(windowId)
    );
    for (const entry of toRemove) {
      this.removeEntry(entry.id);
      console.log(`[ReloadCache] Invalidated entry "${entry.label}" (window ${windowId} closed)`);
    }
  }

  /**
   * Enforce MAX_ENTRIES via LRU and remove expired entries.
   */
  private evict(): void {
    const now = Date.now();

    // Remove expired entries
    this.entries = this.entries.filter(entry => {
      if (now - entry.lastUsedAt > MAX_AGE_MS) {
        this.exactMap.delete(entry.fingerprintKey);
        return false;
      }
      return true;
    });

    // LRU eviction if still over capacity
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      const removed = this.entries.splice(MAX_ENTRIES);
      for (const entry of removed) {
        this.exactMap.delete(entry.fingerprintKey);
      }
    }
  }

  private removeEntry(id: string): void {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx !== -1) {
      const entry = this.entries[idx];
      this.exactMap.delete(entry.fingerprintKey);
      this.entries.splice(idx, 1);
      this.scheduleSave();
    }
  }
}
