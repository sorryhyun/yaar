/**
 * Verb layer -- generic describe/read/list/invoke/delete tools for yaar:// URIs.
 *
 * Merged from mcp/verbs/index.ts + mcp/verbs/tools.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceRegistry } from './uri/registry.js';
import type { WindowStateRegistry } from '../mcp/window-state.js';
import { getSessionId } from '../agents/session.js';
import { getSessionHub } from '../session/session-hub.js';
import { registerConfigHandlers } from './config.js';
import { registerBasicHandlers } from './basic.js';
import { registerWindowHandlers } from './window.js';
import { registerUserHandlers } from './user.js';
import { registerAppsHandlers } from './apps.js';
import { registerSessionHandlers } from './session.js';
import { registerBrowserHandlers } from './browser.js';
import { registerAgentsHandlers } from './agents.js';
import { registerSkillsHandlers } from './skills.js';

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
  if (!session) throw new Error('No active session -- connect via WebSocket first.');
  return session.windowState;
}

/** Create the singleton registry and register all domain handlers. */
export function initRegistry(): ResourceRegistry {
  if (registry) return registry;
  registry = new ResourceRegistry();

  // Register domain handlers -- add new domains here
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

// ── Tool registration (from tools.ts) ──

/** Spread to satisfy MCP SDK's index-signature requirement on tool results. */
const exec = async (reg: ResourceRegistry, ...args: Parameters<ResourceRegistry['execute']>) => {
  const result = await reg.execute(...args);
  return { ...result };
};

/** Register the 5 verb tools on an MCP server instance. */
export function registerVerbTools(server: McpServer): void {
  const reg = initRegistry();

  server.registerTool(
    'describe',
    {
      description:
        'Describe a yaar:// resource -- returns supported verbs, description, and invoke schema.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to describe'),
      },
    },
    async ({ uri }) => exec(reg, 'describe', uri),
  );

  server.registerTool(
    'read',
    {
      description: 'Read the current value/state of a yaar:// resource.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to read'),
      },
    },
    async ({ uri }) => exec(reg, 'read', uri),
  );

  server.registerTool(
    'list',
    {
      description: 'List child resources under a yaar:// URI.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to list children of'),
      },
    },
    async ({ uri }) => exec(reg, 'list', uri),
  );

  server.registerTool(
    'invoke',
    {
      description: 'Invoke an action on a yaar:// resource (create, update, trigger).',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to invoke'),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Action-specific payload (see describe for schema)'),
      },
    },
    async ({ uri, payload }) => exec(reg, 'invoke', uri, payload),
  );

  server.registerTool(
    'delete',
    {
      description: 'Delete a yaar:// resource.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to delete'),
      },
    },
    async ({ uri }) => exec(reg, 'delete', uri),
  );
}
