/**
 * System tools - system info, environment, memorize, config, relay, sandbox, create_sandbox.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInfoTools } from './info.js';
import { registerConfigTools } from './config.js';
import { registerRelayTools } from './relay.js';
import { registerSandboxTools } from './sandbox.js';
import { registerCreateSandboxTools } from './create-sandbox.js';

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__get_info',
  'mcp__system__memorize',
  'mcp__system__set_config',
  'mcp__system__get_config',
  'mcp__system__remove_config',
  'mcp__system__relay_to_main',
  'mcp__system__run_js',
  'mcp__system__create_sandbox',
] as const;

export function registerSystemTools(server: McpServer): void {
  registerInfoTools(server);
  registerConfigTools(server);
  registerRelayTools(server);
  registerSandboxTools(server);
  registerCreateSandboxTools(server);
}
