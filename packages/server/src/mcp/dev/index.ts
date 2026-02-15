/**
 * App development tools - write, compile, and deploy TypeScript apps.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from './read.js';
import { registerWriteTools } from './write.js';
import { registerCompileTools } from './compile.js';
import { registerDeployTools } from './deploy.js';

export const DEV_TOOL_NAMES = [
  'mcp__dev__read_ts',
  'mcp__dev__write_ts',
  'mcp__dev__apply_diff_ts',
  'mcp__dev__compile',
  'mcp__dev__compile_component',
  'mcp__dev__typecheck',
  'mcp__dev__deploy',
  'mcp__dev__clone',
  'mcp__dev__write_json',
] as const;

export function registerAppDevTools(server: McpServer): void {
  registerReadTools(server);
  registerWriteTools(server);
  registerCompileTools(server);
  registerDeployTools(server);
}
