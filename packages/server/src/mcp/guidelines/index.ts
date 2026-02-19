/**
 * Guideline tool — dynamically load reference docs for tool groups.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ok, error } from '../utils.js';
import { getAvailableBundledLibraries } from '../../lib/compiler/plugins.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOPICS: Record<string, string> = {
  app_dev: 'app_dev.md',
  sandbox: 'sandbox.md',
  components: 'components.md',
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
      const filename = TOPICS[args.topic];
      if (!filename) {
        return error(`Unknown topic "${args.topic}". Available: ${topicList}`);
      }

      try {
        let content = await readFile(join(__dirname, filename), 'utf-8');
        if (content.includes('{{BUNDLED_LIBRARIES}}')) {
          const libs = getAvailableBundledLibraries()
            .map((l) => `\`@bundled/${l}\``)
            .join(', ');
          content = content.replace('{{BUNDLED_LIBRARIES}}', libs);
        }
        return ok(content);
      } catch {
        return error(`Could not load guideline for "${args.topic}".`);
      }
    },
  );
}
