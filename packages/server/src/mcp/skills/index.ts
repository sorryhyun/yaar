/**
 * Skill tool — dynamically load reference docs for tool groups.
 *
 * Content is imported at build time so it works in both dev mode and
 * bundled executables (where the .md files aren't on disk).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { TOPICS, TOPIC_NAMES, getTopicContent } from './topics.js';

export { SKILL_TOOL_NAMES } from './names.js';

export function registerSkillTools(server: McpServer): void {
  const topicList = TOPIC_NAMES.join(', ');

  server.registerTool(
    'skill',
    {
      description: `Load a skill — reference docs you MUST read before using related tools. Available: ${topicList}`,
      inputSchema: {
        topic: z
          .enum(Object.keys(TOPICS) as [string, ...string[]])
          .describe(`Topic name: ${topicList}`),
      },
    },
    async (args) => {
      const content = getTopicContent(args.topic);
      if (!content) {
        return error(`Unknown topic "${args.topic}". Available: ${topicList}`);
      }
      return ok(content);
    },
  );
}
