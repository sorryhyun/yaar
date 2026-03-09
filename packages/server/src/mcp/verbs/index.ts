/**
 * Verb layer — generic describe/read/list/invoke/delete tools for yaar:// URIs.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceRegistry } from '../../uri/registry.js';
import type { WindowStateRegistry } from '../window-state.js';
import { getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import { registerVerbTools as registerTools } from './tools.js';
import { registerConfigHandlers } from './handlers/config.js';
import { registerBasicHandlers } from './handlers/basic.js';
import { registerWindowHandlers } from './handlers/window.js';
import { registerUserHandlers } from './handlers/user.js';
import { registerAppsHandlers } from './handlers/apps.js';
import { registerSessionHandlers } from './handlers/session.js';
import { registerBrowserHandlers } from './handlers/browser.js';
import { registerAgentsHandlers } from './handlers/agents.js';
import { registerSkillsHandlers } from './handlers/skills.js';

export const VERB_TOOL_NAMES = [
  'mcp__verbs__describe',
  'mcp__verbs__read',
  'mcp__verbs__list',
  'mcp__verbs__invoke',
  'mcp__verbs__delete',
] as const;

let registry: ResourceRegistry | null = null;

/** Lazy session-scoped WindowStateRegistry lookup (same pattern as mcp/server.ts). */
function getWindowState(): WindowStateRegistry {
  const sid = getSessionId();
  const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
  if (!session) throw new Error('No active session — connect via WebSocket first.');
  return session.windowState;
}

/** Create the singleton registry and register all domain handlers. */
export function initRegistry(): ResourceRegistry {
  if (registry) return registry;
  registry = new ResourceRegistry();

  // Register domain handlers — add new domains here
  registerConfigHandlers(registry);
  registerBasicHandlers(registry);
  registerWindowHandlers(registry, getWindowState);
  registerUserHandlers(registry);
  registerAppsHandlers(registry);
  registerSessionHandlers(registry);
  registerAgentsHandlers(registry);
  registerSkillsHandlers(registry);

  // Browser handlers are async (conditional on Chrome availability)
  registerBrowserHandlers(registry).catch(() => {
    // Silently skip if Chrome not available
  });

  return registry;
}

/** Register the 5 verb tools on an MCP server instance. */
export function registerVerbTools(server: McpServer): void {
  const reg = initRegistry();
  registerTools(server, reg);
}
