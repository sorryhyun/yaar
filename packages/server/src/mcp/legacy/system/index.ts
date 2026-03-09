/**
 * System tools - system info, environment, memorize, relay, sandbox, create_sandbox, notification.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInfoTools } from './info.js';
import { registerRelayTools } from './relay.js';
import { registerSandboxTools } from './sandbox.js';
import { registerCreateSandboxTools } from './create-sandbox.js';
import { registerNotificationTools } from './notification.js';

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__get_info',
  'mcp__system__memorize',
  'mcp__system__relay_to_main',
  'mcp__system__run_js',
  'mcp__system__create_sandbox',
  'mcp__system__show_notification',
] as const;

export function registerSystemTools(server: McpServer): void {
  registerInfoTools(server);
  registerRelayTools(server);
  registerSandboxTools(server);
  registerCreateSandboxTools(server);
  registerNotificationTools(server);
}
