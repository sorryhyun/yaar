/**
 * Verb layer -- generic describe/read/list/invoke/delete tools for yaar:// URIs.
 *
 * Merged from mcp/verbs/index.ts + mcp/verbs/tools.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceRegistry, type VerbResult } from './uri-registry.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import { getActiveSession, formatBatchResults } from './utils.js';
import { expandBraceUri } from '@yaar/shared';
import { registerConfigHandlers } from './config.js';
import { registerStorageHandlers } from './storage.js';
import { registerWindowHandlers } from './window.js';
import { registerUserHandlers } from './user.js';
import { registerAppsHandlers } from './apps.js';
import { registerSessionHandlers } from './session.js';
import { registerHistoryHandlers } from './history.js';
import { registerAgentsHandlers } from './agents.js';
import { registerSkillsHandlers } from './skills.js';
import { registerSystemHandlers } from './system.js';
import { registerFontHandlers } from './fonts.js';
import { registerHttpHandlers } from './http.js';
import { registerMcpGatewayHandlers } from './mcp-gateway.js';
import { recordVerbCall } from '../mcp/tool-call-buffer.js';
import { LARGE_RESULT_META } from '../mcp/result-size.js';
import { getAgentId, getMonitorId, getWindowId } from '../agents/agent-context.js';

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
  registerSessionHandlers(registry);
  registerHistoryHandlers(registry);
  registerAgentsHandlers(registry);
  registerSkillsHandlers(registry);
  registerSystemHandlers(registry);
  registerFontHandlers(registry);
  registerHttpHandlers(registry);
  registerMcpGatewayHandlers(registry);

  return registry;
}

// ── Tool registration (from tools.ts) ──

/**
 * Append layout context to a tool result if layout has changed since
 * this agent last received it. Monitor agents get full layout (viewport +
 * all windows); window/app agents get only their own window bounds.
 */
function appendLayoutContext(result: VerbResult): VerbResult {
  try {
    const agentId = getAgentId();
    if (!agentId) return result;

    const session = getActiveSession();
    const ctx = session.layoutContext;
    const monitorId = getMonitorId();
    const windowId = getWindowId();

    let contextText: string | null = null;

    if (windowId) {
      // Window/app agent — only own window bounds
      contextText = ctx.getWindowAgentContext(agentId, windowId);
    } else if (monitorId) {
      // Monitor agent — viewport + all windows on this monitor
      contextText = ctx.getMonitorAgentContext(agentId, monitorId);
    }

    if (contextText) {
      return {
        ...result,
        content: [...result.content, { type: 'text' as const, text: contextText }],
      };
    }
  } catch {
    // No active session — skip context injection
  }
  return result;
}

/** Spread to satisfy MCP SDK's index-signature requirement on tool results. */
const exec = async (reg: ResourceRegistry, ...args: Parameters<ResourceRegistry['execute']>) => {
  const [verb, uri, payload, readOptions] = args;
  const expanded = expandBraceUri(uri);

  if (expanded.length === 1) {
    // Normal single-URI path
    recordVerbCall(verb, uri, payload);
    const result = await reg.execute(...args);
    return { ...appendLayoutContext(result) };
  }

  // Multi-URI: execute all in parallel, format combined result
  const settled = await Promise.allSettled(
    expanded.map((u: string) => {
      recordVerbCall(verb, u, payload);
      return reg.execute(verb, u, payload, readOptions);
    }),
  );
  return { ...appendLayoutContext(formatBatchResults(expanded, settled)) };
};

/** Register the 5 verb tools on an MCP server instance. */
export function registerVerbTools(server: McpServer): void {
  const reg = initRegistry();

  server.registerTool(
    'describe',
    {
      description:
        'Describe a yaar:// resource -- returns supported verbs, description, and invoke schema. ' +
        'URIs support brace expansion: yaar://storage/{a,b,c} describes all 3 at once.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to describe'),
      },
      _meta: LARGE_RESULT_META,
    },
    async ({ uri }) => exec(reg, 'describe', uri),
  );

  server.registerTool(
    'read',
    {
      description:
        'Read the current value/state of a yaar:// resource. ' +
        'For text files, optionally filter by line range or regex pattern. ' +
        'Reading a PDF returns its metadata plus a hint to open it in a viewer window — it does ' +
        'NOT ingest the content unless you pass pdfText (text layer) or pdfPages (page images). ' +
        'URIs support brace expansion: yaar://storage/{a,b,c} reads all 3 files at once.',
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
        pdfText: z
          .union([z.boolean(), z.string()])
          .optional()
          .describe(
            'PDF only: extract the text layer. true (or "all") reads the whole document; ' +
              'a range like "1-3" scopes it. Cheapest way to read a text-based PDF.',
          ),
        pdfPages: z
          .string()
          .optional()
          .describe(
            'PDF only: page range to rasterize to images, e.g. "1-3", "5", "2-" — for ' +
              'scanned/visual PDFs. Omit both pdfText and pdfPages to just get metadata + a ' +
              'hint to open a viewer window.',
          ),
        rawImage: z
          .boolean()
          .optional()
          .describe(
            'Images only: return the stored bytes instead of the smaller WebP re-encode ' +
              'reads normally apply. Only when the exact pixels matter.',
          ),
      },
      _meta: LARGE_RESULT_META,
    },
    async ({ uri, lines, pattern, context, pdfText, pdfPages, rawImage }) =>
      exec(reg, 'read', uri, undefined, { lines, pattern, context, pdfText, pdfPages, rawImage }),
  );

  server.registerTool(
    'list',
    {
      description:
        'List child resources under a yaar:// URI. ' +
        'URIs support brace expansion: yaar://storage/{dir1,dir2} lists both.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to list children of'),
      },
      _meta: LARGE_RESULT_META,
    },
    async ({ uri }) => exec(reg, 'list', uri),
  );

  server.registerTool(
    'invoke',
    {
      description:
        'Invoke an action on a yaar:// resource (create, update, trigger). ' +
        'Batches on either axis: URIs support brace expansion (yaar://storage/{a,b} ' +
        'invokes on both, in parallel), and payload accepts an ARRAY to run the same URI ' +
        'once per element, in order, as one call — e.g. invoke(".../commands/setTransform", ' +
        '[{id:"a",...},{id:"b",...}]). Use the array form instead of N identical calls that ' +
        'differ only in their payload. It stops at the first failure and reports the index.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to invoke'),
        payload: z
          .union([
            z.record(z.string(), z.unknown()),
            z.array(z.record(z.string(), z.unknown())).max(100),
          ])
          .optional()
          .describe(
            'Action-specific payload (see describe for schema), or an array of payloads ' +
              'to run against this URI in order.',
          ),
      },
      _meta: LARGE_RESULT_META,
    },
    async ({ uri, payload }) => exec(reg, 'invoke', uri, payload),
  );

  server.registerTool(
    'delete',
    {
      description:
        'Delete a yaar:// resource. ' +
        'URIs support brace expansion: yaar://storage/{a,b} deletes both.',
      inputSchema: {
        uri: z.string().describe('yaar:// URI to delete'),
      },
    },
    async ({ uri }) => exec(reg, 'delete', uri),
  );
}
