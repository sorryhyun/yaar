/**
 * Skill tool — dynamically load reference docs for tool groups.
 *
 * Content is imported at build time so it works in both dev mode and
 * bundled executables (where the .md files aren't on disk).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { getAvailableBundledLibraries } from '../../lib/compiler/plugins.js';
import type { EndpointMeta } from '../../http/utils.js';
import { PUBLIC_ENDPOINTS as apiEndpoints } from '../../http/routes/api.js';
import { PUBLIC_ENDPOINTS as fileEndpoints } from '../../http/routes/files.js';
import { PUBLIC_ENDPOINTS as proxyEndpoints } from '../../http/routes/proxy.js';

function renderEndpointTable(): string {
  const all: EndpointMeta[] = [...apiEndpoints, ...fileEndpoints, ...proxyEndpoints];
  const rows = all.map((e) => `| ${e.method} | \`${e.path}\` | ${e.response} | ${e.description} |`);
  return [
    '| Method | Endpoint | Response | Description |',
    '|--------|----------|----------|-------------|',
    ...rows,
  ].join('\n');
}

// Bun text imports — content inlined at build time for exe bundles
// @ts-expect-error: Bun text import
import appDevMd from './app_dev.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import sandboxMd from './sandbox.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import componentsMd from './components.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import hostApiMd from './host_api.md' with { type: 'text' };
// @ts-expect-error: Bun text import
import appProtocolMd from './app_protocol.md' with { type: 'text' };

const TOPICS: Record<string, string> = {
  app_dev: appDevMd,
  sandbox: sandboxMd,
  components: componentsMd,
  host_api: hostApiMd,
  app_protocol: appProtocolMd,
};

export { SKILL_TOOL_NAMES } from './names.js';

export function registerSkillTools(server: McpServer): void {
  const topicList = Object.keys(TOPICS).join(', ');

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
      if (content.includes('{{HOST_API_ENDPOINTS}}')) {
        content = content.replace('{{HOST_API_ENDPOINTS}}', renderEndpointTable());
      }
      return ok(content);
    },
  );
}
