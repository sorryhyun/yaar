/**
 * MCP tool registration aggregator.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerName } from '../server.js';
import { registerSystemTools } from './system.js';
import { registerWindowTools } from './window.js';
import { registerStorageTools } from './storage.js';
import { registerAppsTools } from './apps.js';
import { registerHttpTools } from './http.js';
import { registerAppDevTools } from './app-dev.js';

export { registerSystemTools } from './system.js';
export { registerWindowTools } from './window.js';
export { registerStorageTools } from './storage.js';
export { registerAppsTools } from './apps.js';
export { registerHttpTools } from './http.js';
export { registerAppDevTools } from './app-dev.js';

/**
 * Register all YAAR tools on their respective MCP servers.
 */
export function registerAllTools(servers: Record<McpServerName, McpServer>): void {
  registerSystemTools(servers.system);
  registerHttpTools(servers.system);
  registerWindowTools(servers.window);
  registerStorageTools(servers.storage);
  registerAppsTools(servers.apps);
  registerAppDevTools(servers.apps);
}

/**
 * Get the list of MCP tool names for YAAR.
 */
export function getToolNames(): string[] {
  return [
    // Built-in Claude tools
    'WebSearch',
    // System tools
    'mcp__system__get_time',
    'mcp__system__calculate',
    'mcp__system__get_info',
    'mcp__system__get_env_var',
    'mcp__system__generate_random',
    'mcp__system__request_allowing_domain',
    'mcp__system__http_get',
    'mcp__system__http_post',
    // Window tools
    'mcp__window__create',
    'mcp__window__create_component',
    'mcp__window__update',
    'mcp__window__update_component',
    'mcp__window__close',
    'mcp__window__lock',
    'mcp__window__unlock',
    'mcp__window__list',
    'mcp__window__view',
    'mcp__window__show_notification',
    'mcp__window__dismiss_notification',
    // Storage tools
    'mcp__storage__read',
    'mcp__storage__write',
    'mcp__storage__list',
    'mcp__storage__delete',
    // Apps tools
    'mcp__apps__list',
    'mcp__apps__load_skill',
    'mcp__apps__read_config',
    'mcp__apps__write_config',
    // App development tools
    'mcp__apps__write_ts',
    'mcp__apps__compile',
    'mcp__apps__deploy',
  ];
}
