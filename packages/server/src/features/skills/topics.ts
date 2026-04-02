/**
 * Skill topic content — reference docs loaded by the verb-layer
 * `yaar://skills/*` handler.
 *
 * Content is imported at build time via Bun text imports so it works
 * in both dev mode and bundled executables.
 */

import { getAvailableBundledLibraries } from '@yaar/compiler';
import { MARKET_URL } from '../../config.js';

// Bun text imports — content inlined at build time for exe bundles
// @ts-expect-error: Bun text import
import componentsMd from './components.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import configMd from './config.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import marketplaceMd from './marketplace.md' with { type: 'text' };

export const TOPICS: Record<string, string> = {
  components: componentsMd,
  config: configMd,
  marketplace: marketplaceMd,
};

export const TOPIC_NAMES = Object.keys(TOPICS);

/**
 * Get the resolved content for a topic, with template substitutions applied.
 * Returns null if the topic is not found.
 */
export function getTopicContent(topic: string): string | null {
  let content = TOPICS[topic];
  if (!content) return null;

  if (content.includes('{{BUNDLED_LIBRARIES}}')) {
    const libs = getAvailableBundledLibraries()
      .map((l: string) => `\`@bundled/${l}\``)
      .join(', ');
    content = content.replace('{{BUNDLED_LIBRARIES}}', libs);
  }
  if (content.includes('{{MARKET_URL}}')) {
    content = content.replaceAll('{{MARKET_URL}}', MARKET_URL);
  }
  return content;
}
