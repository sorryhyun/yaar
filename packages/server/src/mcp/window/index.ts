/**
 * Window tools - create, update, close, toast, lock/unlock, list, view.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WindowStateRegistry } from '../window-state.js';
import { registerCreateTools } from './create.js';
import { registerUpdateTools } from './update.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerNotificationTools } from './notification.js';
import { registerAppProtocolTools } from './app-protocol.js';

export const WINDOW_TOOL_NAMES = [
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
  registerNotificationTools(server);
  registerAppProtocolTools(server, getWindowState);
}
