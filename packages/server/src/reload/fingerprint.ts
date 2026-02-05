/**
 * Fingerprinting for the action reload cache.
 *
 * Computes fingerprints from task content and window state to enable
 * both exact and fuzzy matching of previously seen contexts.
 */

import { createHash } from 'crypto';
import type { WindowState } from '@yaar/shared';
import type { Task } from '../agents/context-pool.js';
import type { Fingerprint } from './types.js';

/**
 * Strip XML wrappers and normalize content for fingerprinting.
 * Removes <open_windows>, <user_interaction:...> tags, lowercases, collapses whitespace.
 */
export function normalizeContent(text: string): string {
  return text
    .replace(/<open_windows>[\s\S]*?<\/open_windows>/g, '')
    .replace(/<user_interaction:\w+>[\s\S]*?<\/user_interaction:\w+>/g, '')
    .replace(/<previous_interactions>[\s\S]*?<\/previous_interactions>/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute word-level n-grams from normalized text.
 */
export function computeNgrams(text: string, n: number = 2): string[] {
  const words = text.split(' ').filter(w => w.length > 0);
  if (words.length < n) return words.length > 0 ? [words.join(' ')] : [];

  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/**
 * Compute Jaccard similarity between two sets of strings.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;

  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute SHA-256 hash of normalized text.
 */
export function computeContentHash(text: string): string {
  const normalized = normalizeContent(text);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Compute hash of sorted window IDs and renderers.
 */
export function computeWindowStateHash(windows: WindowState[]): string {
  const sorted = windows
    .map(w => `${w.id}:${w.content.renderer}`)
    .sort()
    .join('|');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

/**
 * Compute a full fingerprint from a task and window snapshot.
 */
export function computeFingerprint(task: Task, windows: WindowState[]): Fingerprint {
  const normalized = normalizeContent(task.content);
  const ngrams = computeNgrams(normalized);
  const contentHash = computeContentHash(task.content);
  const windowStateHash = computeWindowStateHash(windows);

  return {
    triggerType: task.type,
    triggerTarget: task.windowId,
    ngrams,
    contentHash,
    windowStateHash,
  };
}

/**
 * Compute similarity between two fingerprints.
 * Weighted: 50% trigger match + 30% n-gram Jaccard + 20% window state match.
 */
export function computeSimilarity(a: Fingerprint, b: Fingerprint): number {
  // 50% trigger match
  let triggerScore = 0;
  if (a.triggerType === b.triggerType) {
    triggerScore = 0.5;
    if (a.triggerTarget && b.triggerTarget && a.triggerTarget !== b.triggerTarget) {
      triggerScore = 0.25;
    }
  }

  // 30% n-gram Jaccard similarity
  const ngramScore = jaccardSimilarity(a.ngrams, b.ngrams) * 0.3;

  // 20% window state match
  const windowScore = a.windowStateHash === b.windowStateHash ? 0.2 : 0;

  return triggerScore + ngramScore + windowScore;
}
