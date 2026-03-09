/**
 * Window tools - create, update, manage (close/lock/unlock), list, view, info, app protocol.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WindowStateRegistry } from '../../window-state.js';
import { registerCreateTools } from './create.js';
import { registerUpdateTools } from './update.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerAppProtocolTools } from './app-protocol.js';

export const WINDOW_TOOL_NAMES = [
  'mcp__window__create',
  'mcp__window__create_component',
  'mcp__window__update',
  'mcp__window__update_component',
  'mcp__window__manage',
  'mcp__window__list',
  'mcp__window__view',
  'mcp__window__info',
  'mcp__window__app_query',
  'mcp__window__app_command',
] as const;

export function registerWindowTools(
  server: McpServer,
  getWindowState: () => WindowStateRegistry,
): void {
  registerCreateTools(server);
  registerUpdateTools(server, getWindowState);
  registerLifecycleTools(server, getWindowState);
  registerAppProtocolTools(server, getWindowState);
}
