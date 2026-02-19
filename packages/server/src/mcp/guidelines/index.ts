/**
 * Guideline tool — dynamically load reference docs for tool groups.
 *
 * Content is imported at build time so it works in both dev mode and
 * bundled executables (where the .md files aren't on disk).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { getAvailableBundledLibraries } from '../../lib/compiler/plugins.js';

// Bun text imports — content inlined at build time for exe bundles
// @ts-expect-error: Bun text import
import appDevMd from './app_dev.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import sandboxMd from './sandbox.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import componentsMd from './components.md' with { type: 'text' };

const TOPICS: Record<string, string> = {
  app_dev: appDevMd,
  sandbox: sandboxMd,
  components: componentsMd,
};

export const GUIDELINE_TOOL_NAMES = ['mcp__system__guideline'] as const;

export function registerGuidelineTools(server: McpServer): void {
  const topicList = Object.keys(TOPICS).join(', ');

  server.registerTool(
    'guideline',
    {
      description: `Load reference documentation for a topic. Available: ${topicList}`,
      inputSchema: {
        topic: z
          .enum(Object.keys(TOPICS) as [string, ...string[]])
          .describe(`Topic name: ${topicList}`),
      },
    },
    async (args) => {
      let content = TOPICS[args.topic];
      if (!content) {
        return error(`Unknown topic "${args.topic}". Available: ${topicList}`);
      }

      if (content.includes('{{BUNDLED_LIBRARIES}}')) {
        const libs = getAvailableBundledLibraries()
          .map((l) => `\`@bundled/${l}\``)
          .join(', ');
        content = content.replace('{{BUNDLED_LIBRARIES}}', libs);
      }
      return ok(content);
    },
  );
}
