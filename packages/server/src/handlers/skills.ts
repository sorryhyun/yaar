/**
 * Skills domain handlers for the verb layer.
 *
 * Serves reference documentation for tool topics:
 *
 *   list('yaar://skills')          → list available topic names
 *   read('yaar://skills/{topic}')  → read topic content
 *
 * Topic content and template resolution are loaded lazily to avoid
 * pulling in .md text imports at module evaluation time (which breaks
 * vitest's module graph).
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, okJson, error, extractIdFromUri } from './utils.js';

/** Known topic names — kept in sync with skills/index.ts. */
const TOPIC_NAMES = ['app_dev', 'sandbox', 'components', 'host_api', 'app_protocol', 'config'];

/** Lazily load and resolve a topic's content (with template substitution). */
async function loadTopic(topic: string): Promise<string | null> {
  // Dynamic import keeps .md text imports out of the static module graph
  const { getTopicContent } = await import('../features/skills/topics.js');
  return getTopicContent(topic);
}

export function registerSkillsHandlers(registry: ResourceRegistry): void {
  // ── yaar://skills — list available topics ──
  registry.register('yaar://skills', {
    description: `List available skill topics. Topics: ${TOPIC_NAMES.join(', ')}`,
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      return okJson({ topics: TOPIC_NAMES });
    },
  });

  // ── yaar://skills/* — read a specific topic ──
  registry.register('yaar://skills/*', {
    description: 'Read a skill topic — reference docs you MUST read before using related tools.',
    verbs: ['describe', 'read'],

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const topic = extractIdFromUri(resolved.sourceUri, 'skills');
      if (!topic) return error('Provide a topic name (e.g. yaar://skills/components).');

      const content = await loadTopic(topic);
      if (!content) {
        return error(`Unknown topic "${topic}". Available: ${TOPIC_NAMES.join(', ')}`);
      }

      return ok(content);
    },
  });
}
