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

export function registerWindowTools(server: McpServer, getWindowState: () => WindowStateRegistry): void {
  registerCreateTools(server);
  registerUpdateTools(server, getWindowState);
  registerLifecycleTools(server, getWindowState);
  registerNotificationTools(server);
  registerAppProtocolTools(server, getWindowState);
}
