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

import type { ResourceRegistry } from './uri-registry.js';
import { okResource, okLinks, error, type VerbResult } from '../lib/verb-result.js';
import { extractIdFromUri } from './utils.js';
import type { ResolvedUri } from './uri-resolve.js';
// Names only — importing topics.js here would pull its `.md` text imports into the
// static module graph. topics.ts asserts this list matches what it actually serves.
import { TOPIC_NAMES, TOPIC_WHEN } from '../features/skills/topic-names.js';

/**
 * What skills are for, shared by both doors. It names the trigger — something specific to
 * YAAR that general knowledge gets wrong — and leaves picking a topic to `list`, whose
 * entries each say when they apply. A per-topic roster here, with "MUST"/"REQUIRED" on
 * each line, read as a checklist to clear before every tool rather than a place to look.
 */
const SKILLS_PURPOSE =
  "YAAR's own how-to notes for what is specific to this system — setup, conventions and " +
  'quirks general knowledge will not cover. Look here when the user asks how something in ' +
  'YAAR works or the task depends on YAAR-specific behavior.';

/** Lazily load and resolve a topic's content (with template substitution). */
async function loadTopic(topic: string): Promise<string | null> {
  // Dynamic import keeps .md text imports out of the static module graph
  const { getTopicContent } = await import('../features/skills/topics.js');
  return getTopicContent(topic);
}

export function registerSkillsHandlers(registry: ResourceRegistry): void {
  // ── yaar://skills — list available topics ──
  registry.register('yaar://skills', {
    description: `${SKILLS_PURPOSE} Lists each topic with when it applies.`,
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      return okLinks(
        TOPIC_NAMES.map((t) => ({
          uri: `yaar://skills/${t}`,
          name: t,
          description: TOPIC_WHEN[t],
          mimeType: 'text/markdown',
        })),
      );
    },
  });

  // ── yaar://skills/* — read a specific topic ──
  registry.register('yaar://skills/*', {
    description: `${SKILLS_PURPOSE} Read one topic; list('yaar://skills') says which topic fits. Use read, not list; a topic is a document, not a collection.`,
    verbs: ['describe', 'read'],

    async exists(resolved: ResolvedUri): Promise<boolean> {
      const topic = extractIdFromUri(resolved.sourceUri, 'skills');
      return !!topic && (TOPIC_NAMES as readonly string[]).includes(topic);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const topic = extractIdFromUri(resolved.sourceUri, 'skills');
      if (!topic) return error('Provide a topic name (e.g. yaar://skills/components).');

      const content = await loadTopic(topic);
      if (!content) {
        return error(`Unknown topic "${topic}". Available: ${TOPIC_NAMES.join(', ')}`);
      }

      return okResource(resolved.sourceUri, content, 'text/markdown');
    },
  });
}
