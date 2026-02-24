/**
 * System tools - system info, environment, memorize, config, relay.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInfoTools } from './info.js';
import { registerConfigTools } from './config.js';
import { registerRelayTools } from './relay.js';

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__get_info',
  'mcp__system__memorize',
  'mcp__system__set_config',
  'mcp__system__get_config',
  'mcp__system__remove_config',
  'mcp__system__relay_to_main',
] as const;

export function registerSystemTools(server: McpServer): void {
  registerInfoTools(server);
  registerConfigTools(server);
  registerRelayTools(server);
}
