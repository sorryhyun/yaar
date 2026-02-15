/**
 * MCP tool registration aggregator.
 *
 * Wires each domain's tools to the correct MCP server namespace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerName } from './server.js';
import { registerSystemTools, SYSTEM_TOOL_NAMES } from './system/index.js';
import { registerDispatchTools, DISPATCH_TOOL_NAMES } from './system/dispatch.js';
import { registerWindowTools, WINDOW_TOOL_NAMES } from './window/index.js';
import { registerStorageTools, STORAGE_TOOL_NAMES } from './storage/index.js';
import { registerAppsTools, APPS_TOOL_NAMES } from './apps/index.js';
import { registerMarketTools, MARKET_TOOL_NAMES } from './apps/market.js';
import { registerHttpTools, HTTP_TOOL_NAMES } from './http/index.js';
import { registerAppDevTools, DEV_TOOL_NAMES } from './dev/index.js';
import { registerSandboxTools, SANDBOX_TOOL_NAMES } from './sandbox/index.js';
import { registerGuidelineTools, GUIDELINE_TOOL_NAMES } from './guidelines/index.js';
import { registerReloadTools, RELOAD_TOOL_NAMES } from '../reload/tools.js';
import { getSessionHub } from '../session/live-session.js';
import type { WindowStateRegistry } from './window-state.js';
import type { ReloadCache } from '../reload/cache.js';
import { APP_DEV_ENABLED } from '../config.js';
import { registerBrowserTools, BROWSER_TOOL_NAMES } from './browser/index.js';

/**
 * Register all YAAR tools on their respective MCP servers.
 */
export function registerAllTools(servers: Record<McpServerName, McpServer>): void {
  const getWindowState = (): WindowStateRegistry => {
    const session = getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.windowState;
  };
  const getReloadCache = (): ReloadCache => {
    const session = getSessionHub().getDefault();
    if (!session) throw new Error('No active session — connect via WebSocket first.');
    return session.reloadCache;
  };

  registerSystemTools(servers.system);
  registerDispatchTools(servers.system);
  registerGuidelineTools(servers.system);
  registerHttpTools(servers.system);
  registerSandboxTools(servers.system);
  registerWindowTools(servers.window, getWindowState);
  registerStorageTools(servers.storage);
  registerAppsTools(servers.apps);
  registerMarketTools(servers.apps);
  if (APP_DEV_ENABLED) {
    registerAppDevTools(servers.dev);
  }
  registerReloadTools(servers.system, getReloadCache, getWindowState);

  // Browser tools (conditional — only if Chrome/Edge is available)
  registerBrowserTools(servers.browser).catch(() => {
    // Chrome not found — browser tools unavailable
  });
}

/**
 * Format a raw MCP tool name for CLI display.
 * "mcp__apps__read_ts" → "apps:read_ts"
 */
export function formatToolDisplay(raw: string): string {
  const m = raw.match(/^mcp__(\w+)__(.+)$/);
  if (m) return `${m[1]}:${m[2]}`;
  return raw;
}

/**
 * Get the list of MCP tool names for YAAR.
 */
export function getToolNames(): string[] {
  const all: string[] = [
    'WebSearch',
    ...SYSTEM_TOOL_NAMES,
    ...DISPATCH_TOOL_NAMES,
    ...GUIDELINE_TOOL_NAMES,
    ...HTTP_TOOL_NAMES,
    ...SANDBOX_TOOL_NAMES,
    ...WINDOW_TOOL_NAMES,
    ...STORAGE_TOOL_NAMES,
    ...APPS_TOOL_NAMES,
    ...MARKET_TOOL_NAMES,
    ...DEV_TOOL_NAMES,
    ...RELOAD_TOOL_NAMES,
    ...BROWSER_TOOL_NAMES,
  ];
  return APP_DEV_ENABLED ? all : all.filter((n) => !DEV_TOOL_NAMES.includes(n as any));
}
