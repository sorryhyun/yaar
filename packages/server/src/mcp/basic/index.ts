/**
 * Basic MCP namespace — unified file I/O tools (read, write, list, delete, edit).
 *
 * All tools accept URI-style paths:
 *   yaar://sandbox/{sandboxId}/{path}  — sandbox file
 *   yaar://sandbox/new/{path}          — new sandbox (write/edit only)
 *   yaar://storage/{path}              — persistent storage file
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTool } from './read.js';
import { registerWriteTool } from './write.js';
import { registerListTool } from './list.js';
import { registerDeleteTool } from './delete.js';
import { registerEditTool } from './edit.js';

export const BASIC_TOOL_NAMES = [
  'mcp__basic__read',
  'mcp__basic__write',
  'mcp__basic__list',
  'mcp__basic__delete',
  'mcp__basic__edit',
] as const;

export function registerBasicTools(server: McpServer): void {
  registerReadTool(server);
  registerWriteTool(server);
  registerListTool(server);
  registerDeleteTool(server);
  registerEditTool(server);
}
