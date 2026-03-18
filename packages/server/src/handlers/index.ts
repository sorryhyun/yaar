/**
 * Verb layer -- generic describe/read/list/invoke/delete tools for yaar:// URIs.
 *
 * Merged from mcp/verbs/index.ts + mcp/verbs/tools.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceRegistry } from './uri-registry.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import { getActiveSession } from './utils.js';
import { registerConfigHandlers } from './config.js';
import { registerStorageHandlers } from './storage.js';
import { registerWindowHandlers } from './window.js';
import { registerUserHandlers } from './user.js';
import { registerAppsHandlers } from './apps.js';
import { registerMarketHandlers } from './market.js';
import { registerSessionHandlers } from './session.js';
import { registerBrowserHandlers } from './browser.js';
import { registerAgentsHandlers } from './agents.js';
import { registerSkillsHandlers } from './skills.js';
import { registerHttpHandlers } from './http.js';
import { recordVerbCall } from '../mcp/tool-call-buffer.js';

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
  return getActiveSession().windowState;
}

/** Create the singleton registry and register all domain handlers. */
export function initRegistry(): ResourceRegistry {
  if (registry) return registry;
  registry = new ResourceRegistry();

  // Register domain handlers -- add new domains here
  registerConfigHandlers(registry);
  registerStorageHandlers(registry);
  registerWindowHandlers(registry, getWindowState);
  registerUserHandlers(registry);
  registerAppsHandlers(registry);
  registerMarketHandlers(registry);
  registerSessionHandlers(registry);
  registerAgentsHandlers(registry);
  registerSkillsHandlers(registry);
  registerHttpHandlers(registry);

  // Browser handlers are async (conditional on Chrome availability)
  registerBrowserHandlers(registry).catch(() => {
    // Silently skip if Chrome not available
  });

  return registry;
}

// ── Tool registration (from tools.ts) ──

/** Spread to satisfy MCP SDK's index-signature requirement on tool results. */
const exec = async (reg: ResourceRegistry, ...args: Parameters<ResourceRegistry['execute']>) => {
  const [verb, uri, payload] = args;
  recordVerbCall(verb, uri, payload);
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
      description:
        'Read the current value/state of a yaar:// resource. ' +
        'For text files, optionally filter by line range or regex pattern.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to read'),
        lines: z
          .string()
          .optional()
          .describe('Line range to read (1-based, inclusive). E.g. "10-20", "50", "100-"'),
        pattern: z
          .string()
          .optional()
          .describe('Regex pattern — returns only matching lines with line numbers'),
        context: z
          .number()
          .optional()
          .describe('Context lines around pattern matches (default: 0)'),
      },
    },
    async ({ uri, lines, pattern, context }) =>
      exec(reg, 'read', uri, undefined, { lines, pattern, context }),
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
