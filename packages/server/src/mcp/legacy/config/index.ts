/**
 * Config tools — set, get, remove.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConfigTools } from './tools.js';

export const CONFIG_TOOL_NAMES = [
  'mcp__config__set',
  'mcp__config__get',
  'mcp__config__remove',
] as const;

export { registerConfigTools };

export function registerConfigNamespace(server: McpServer): void {
  registerConfigTools(server);
}
