/**
 * MCP tool registration aggregator.
 *
 * Wires each domain's tools to the correct MCP server namespace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerName } from './server.js';
import { registerSystemTools } from './system/index.js';
import { registerWindowTools } from './window/index.js';
import { registerStorageTools } from './storage/index.js';
import { registerAppsTools } from './apps/index.js';
import { registerHttpTools } from './http/index.js';
import { registerAppDevTools } from './app-dev/index.js';
import { registerSandboxTools } from './sandbox/index.js';
import { registerReloadTools } from '../reload/tools.js';
import { getSessionHub } from '../session/live-session.js';
import { WindowStateRegistry } from './window-state.js';
import { ReloadCache } from '../reload/cache.js';

/**
 * Register all YAAR tools on their respective MCP servers.
 */
export function registerAllTools(servers: Record<McpServerName, McpServer>): void {
  const getWindowState = () => {
    const session = getSessionHub().getDefault();
    return session?.windowState ?? new WindowStateRegistry();
  };
  const getReloadCache = () => {
    const session = getSessionHub().getDefault();
    return session?.reloadCache ?? new ReloadCache('/dev/null');
  };

  registerSystemTools(servers.system);
  registerHttpTools(servers.system);
  registerSandboxTools(servers.system);
  registerWindowTools(servers.window, getWindowState);
  registerStorageTools(servers.storage);
  registerAppsTools(servers.apps);
  registerAppDevTools(servers.apps);
  registerReloadTools(servers.system, getReloadCache, getWindowState);
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
    'mcp__system__memorize',
    'mcp__system__request_allowing_domain',
    'mcp__system__http_get',
    'mcp__system__http_post',
    // Sandbox tools
    'mcp__system__run_js',
    'mcp__system__run_ts',
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
    // App protocol tools
    'mcp__window__app_query',
    'mcp__window__app_command',
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
    // Reload cache tools
    'mcp__system__reload_cached',
    'mcp__system__list_reload_options',
  ];
}
