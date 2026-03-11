/**
 * Always-on system-namespace MCP tools (active in both verb and legacy modes).
 *
 * - HTTP: http_get, http_post
 * - Reload: reload_cached, list_reload_options
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRequestTools } from './request.js';

export { registerReloadTools } from './reload.js';

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__http_get',
  'mcp__system__http_post',
  'mcp__system__reload_cached',
  'mcp__system__list_reload_options',
] as const;

export function registerHttpTools(server: McpServer): void {
  registerRequestTools(server);
}
