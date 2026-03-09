/**
 * App development tools - compile, deploy, and related build tools.
 *
 * File I/O (read, write, edit) has been moved to the `basic` namespace.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCompileTools } from './compile.js';
import { registerDeployTools } from './deploy.js';

export const DEV_TOOL_NAMES = [
  'mcp__dev__compile',
  'mcp__dev__typecheck',
  'mcp__dev__deploy',
  'mcp__dev__clone',
] as const;

export function registerAppDevTools(server: McpServer): void {
  registerCompileTools(server);
  registerDeployTools(server);
}
