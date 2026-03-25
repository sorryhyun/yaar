/**
 * Benchmarks for the reload-cache fingerprinting pipeline.
 *
 * These functions sit on the hot path of every cache lookup: a fingerprint is
 * computed for every incoming task and then compared against up to 100 cached
 * entries via a linear similarity scan.  Small regressions here multiply by
 * the number of cache entries, so throughput matters.
 *
 * Run with: bun run --filter @yaar/tests bench
 */

import { bench, group, run } from 'mitata';
import {
  normalizeContent,
  computeNgrams,
  jaccardSimilarity,
  computeSimilarity,
} from '@yaar/server/reload/fingerprint';
import type { Fingerprint } from '@yaar/server/reload/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A realistic prompt string mixing XML wrappers, conversation history, and
 * free-form user text — similar to what the system sends to the AI on each turn.
 */
const TYPICAL_PROMPT = `
<open_windows>win-1:markdown win-2:component win-3:iframe</open_windows>
<previous_conversation>
<user>Please create a dashboard showing my sales metrics for Q4</user>
<ai>I will create a comprehensive dashboard with charts and KPI indicators.</ai>
<user>Add a filter for region and product category</user>
<ai>Adding filter controls to the existing dashboard layout.</ai>
</previous_conversation>
<ui:click>app: github-manager</ui:click>
Show me the top 10 repositories by star count for our organisation, filter by
language TypeScript, sort descending by stars, and include open issue counts
alongside pull request counts and the date of the last commit.
`;

const TYPICAL_PROMPT_VARIANT = TYPICAL_PROMPT.replace('dashboard', 'report')
  .replace('sales', 'revenue')
  .replace('star count', 'fork count');

const WORDS_100 = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');

// Pre-compute ngram sets so individual bench functions are not penalised by
// the cost of normalization when we only want to measure similarity.
const NGRAMS_A = computeNgrams(normalizeContent(TYPICAL_PROMPT));
const NGRAMS_B = computeNgrams(normalizeContent(TYPICAL_PROMPT_VARIANT));
const NGRAMS_EMPTY: string[] = [];

function makeFingerprint(
  contentHash: string,
  windowStateHash: string,
  type: 'monitor' | 'window' = 'monitor',
): Fingerprint {
  return {
    triggerType: type,
    triggerTarget: type === 'window' ? 'win-1' : undefined,
    ngrams: NGRAMS_A.slice(),
    contentHash,
    windowStateHash,
  };
}

// Query fingerprint — represents the incoming cache lookup.
const FP_QUERY = makeFingerprint('abc123def456abc123def456abc123de', 'state001234567890ab');

// High-similarity hit: same window state, slightly different content hash.
const FP_SIMILAR = makeFingerprint('abc123def789abc123def789abc123de', 'state001234567890ab');

// Low-similarity miss: entirely different content and window state.
const FP_DIFFERENT = makeFingerprint('xyz999xyz999xyz999xyz999xyz999xy', 'stateZZZZZZZZZZZZZZ');

// 100-entry pool that mirrors the maximum ReloadCache size.
const FP_POOL: Fingerprint[] = Array.from({ length: 100 }, (_, i) =>
  makeFingerprint(
    `hash${String(i).padStart(28, '0')}`,
    `state${String(i % 10).padStart(15, '0')}`,
    i % 3 === 0 ? 'window' : 'monitor',
  ),
);

// ── Benchmarks ────────────────────────────────────────────────────────────────

group('normalizeContent', () => {
  bench('typical prompt with XML wrappers', () => {
    normalizeContent(TYPICAL_PROMPT);
  });

  bench('100-word plain text (no XML)', () => {
    normalizeContent(WORDS_100);
  });
});

group('computeNgrams', () => {
  bench('bigrams from 100-word text', () => {
    computeNgrams(WORDS_100, 2);
  });

  bench('trigrams from 100-word text', () => {
    computeNgrams(WORDS_100, 3);
  });

  bench('bigrams from normalized typical prompt', () => {
    computeNgrams(normalizeContent(TYPICAL_PROMPT), 2);
  });
});

group('jaccardSimilarity', () => {
  bench('two similar ~40-ngram sets', () => {
    jaccardSimilarity(NGRAMS_A, NGRAMS_B);
  });

  bench('identical sets', () => {
    jaccardSimilarity(NGRAMS_A, NGRAMS_A);
  });

  bench('one empty set (fast-path)', () => {
    jaccardSimilarity(NGRAMS_A, NGRAMS_EMPTY);
  });
});

group('computeSimilarity', () => {
  bench('high-similarity pair', () => {
    computeSimilarity(FP_QUERY, FP_SIMILAR);
  });

  bench('low-similarity pair', () => {
    computeSimilarity(FP_QUERY, FP_DIFFERENT);
  });
});

group('findMatches simulation (O(n) scan)', () => {
  bench('scan 100 fingerprints — all misses', () => {
    for (const fp of FP_POOL) {
      computeSimilarity(FP_QUERY, fp);
    }
  });

  bench('scan 100 fingerprints — first entry is a hit', () => {
    // Simulate the common cache-hit path where we still scan for fuzzy matches.
    for (const fp of FP_POOL) {
      const sim = computeSimilarity(FP_QUERY, fp);
      if (sim >= 0.85) break; // early exit on high-confidence match
    }
  });
});

await run();
