/**
 * Skill topic content — reference docs loaded by the verb-layer
 * `yaar://skills/*` handler.
 *
 * Content is imported at build time via Bun text imports so it works
 * in both dev mode and bundled executables.
 */

import { getAvailableBundledLibraries } from '../../lib/compiler/plugins.js';
import type { EndpointMeta } from '../../http/utils.js';
import { PUBLIC_ENDPOINTS as apiEndpoints } from '../../http/routes/api.js';
import { PUBLIC_ENDPOINTS as fileEndpoints } from '../../http/routes/files.js';
import { PUBLIC_ENDPOINTS as proxyEndpoints } from '../../http/routes/proxy.js';
import { PUBLIC_ENDPOINTS as browseEndpoints } from '../../http/routes/browse.js';

// Bun text imports — content inlined at build time for exe bundles
// @ts-expect-error: Bun text import
import componentsMd from './components.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import hostApiMd from './host_api.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import configMd from './config.md' with { type: 'text' };

export const TOPICS: Record<string, string> = {
  components: componentsMd,
  host_api: hostApiMd,
  config: configMd,
};

export const TOPIC_NAMES = Object.keys(TOPICS);

function renderEndpointTable(): string {
  const all: EndpointMeta[] = [
    ...apiEndpoints,
    ...fileEndpoints,
    ...proxyEndpoints,
    ...browseEndpoints,
  ];
  const rows = all.map((e) => `| ${e.method} | \`${e.path}\` | ${e.response} | ${e.description} |`);
  return [
    '| Method | Endpoint | Response | Description |',
    '|--------|----------|----------|-------------|',
    ...rows,
  ].join('\n');
}

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
  if (content.includes('{{HOST_API_ENDPOINTS}}')) {
    content = content.replace('{{HOST_API_ENDPOINTS}}', renderEndpointTable());
  }
  return content;
}
