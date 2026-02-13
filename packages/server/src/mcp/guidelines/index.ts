/**
 * Guideline tool — dynamically load reference docs for tool groups.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ok } from '../utils.js';
import { getAvailableBundledLibraries } from '../../lib/compiler/plugins.js';
import { APP_DEV_ENABLED } from '../../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_TOPICS: Record<string, string> = {
  app_dev: 'app_dev.md',
  sandbox: 'sandbox.md',
  components: 'components.md',
};

const TOPICS: Record<string, string> = APP_DEV_ENABLED
  ? ALL_TOPICS
  : Object.fromEntries(Object.entries(ALL_TOPICS).filter(([k]) => k !== 'app_dev'));

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
        return ok(`Unknown topic "${args.topic}". Available: ${topicList}`);
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
        return ok(`Error: Could not load guideline for "${args.topic}".`);
      }
    },
  );
}
