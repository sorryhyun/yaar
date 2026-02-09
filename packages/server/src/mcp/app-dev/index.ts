/**
 * App development tools - write, compile, and deploy TypeScript apps.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriteTools } from './write.js';
import { registerCompileTools } from './compile.js';
import { registerDeployTools } from './deploy.js';

export function registerAppDevTools(server: McpServer): void {
  registerWriteTools(server);
  registerCompileTools(server);
  registerDeployTools(server);
}
