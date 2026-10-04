/**
 * Verb layer -- generic describe/read/list/invoke/delete tools for yaar:// URIs.
 *
 * Merged from mcp/verbs/index.ts + mcp/verbs/tools.ts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceRegistry } from './uri-registry.js';
import { foldNotes, formatBatchResults, type VerbResult } from '../lib/verb-result.js';
import { getActiveSession } from './utils.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import { expandBraceUri } from '@yaar/shared';
import { registerConfigHandlers } from './config.js';
import { registerStorageHandlers } from './storage.js';
import { registerWindowHandlers } from './window.js';
import { registerUserHandlers } from './user.js';
import { registerAppsHandlers } from './apps/index.js';
import { registerSessionHandlers } from './session.js';
import { registerHistoryHandlers } from './history.js';
import { registerAgentsHandlers } from './agents.js';
import { registerSkillsHandlers } from './skills.js';
import { registerSystemHandlers } from './system.js';
import { registerFontHandlers } from './fonts.js';
import { registerYtDlpHandlers } from './ytdlp.js';
import { registerHttpHandlers } from './http.js';
import { registerMcpGatewayHandlers } from './mcp-gateway.js';
import { recordVerbCall } from '../mcp/tool-call-buffer.js';
import { resolveShorthandUri } from '../http/uri-match.js';
import { LARGE_RESULT_META } from '../mcp/result-size.js';
import { LIST_PAGE_SIZE } from '../lib/list-options.js';
import { spillOversizedResult } from '../mcp/result-spill.js';
import { strictInput } from '../mcp/strict-input.js';
import { getAgentId, getMonitorId, getWindowId } from '../agents/agent-context.js';
import type { LayoutNote } from '../session/layout-context.js';

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
  registerYtDlpHandlers(registry);
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

    let note: LayoutNote | null = null;

    if (windowId) {
      // Window/app agent — only own window bounds
      note = ctx.getWindowAgentContext(agentId, windowId);
    } else if (monitorId) {
      // Monitor agent — viewport + all windows on this monitor
      note = ctx.getMonitorAgentContext(agentId, monitorId);
    }

    if (note) {
      return {
        ...result,
        content: [...result.content, { type: 'text' as const, text: note.text }],
        // Beside a `structuredContent` the text block never reaches a model (see `okJson`
        // in lib/verb-result.ts), so the layout rides inside the object too — as data, not as the
        // text block, which would arrive as one escaped line. MCP-only, so the app's
        // `POST /api/verb` data never sees the key.
        ...(result.structuredContent
          ? { structuredContent: { ...result.structuredContent, _layout: note.data } }
          : {}),
      };
    }
  } catch {
    // No active session — skip context injection
  }
  return result;
}

/** Spread to satisfy MCP SDK's index-signature requirement on tool results. */
const exec = async (reg: ResourceRegistry, ...args: Parameters<ResourceRegistry['execute']>) => {
  const [verb, rawUri, payload, options] = args;

  // The scheme is optional at this door and nowhere past it. Resolving here — ahead of
  // brace expansion, `recordVerbCall` and the registry — is what keeps that true: the
  // buffered call the message-mapper replays into a sub-agent's activity, and every URI
  // the registry then compares or emits, stay in canonical form regardless of how the
  // model spelled it. Expansion composes because the authority precedes any brace:
  // `storage/{a,b}` becomes `yaar://storage/{a,b}` and then two canonical URIs.
  const uri = resolveShorthandUri(rawUri);
  const expanded = expandBraceUri(uri);

  if (expanded.length === 1) {
    // Normal single-URI path
    recordVerbCall(verb, uri, payload);
    const result = await reg.execute(verb, uri, payload, options);
    return {
      ...appendLayoutContext(await spillOversizedResult(verb, expanded, foldNotes(result))),
    };
  }

  // Multi-URI: execute all in parallel, format combined result
  const settled = await Promise.allSettled(
    expanded.map((u: string) => {
      recordVerbCall(verb, u, payload);
      return reg.execute(verb, u, payload, options);
    }),
  );
  const combined = formatBatchResults(expanded, settled);
  return { ...appendLayoutContext(await spillOversizedResult(verb, expanded, combined)) };
};

/** Register the 5 verb tools on an MCP server instance. */
export function registerVerbTools(server: McpServer): void {
  const reg = initRegistry();

  server.registerTool(
    'describe',
    {
      description:
        'Describe a yaar:// resource -- returns supported verbs, description, and invoke schema.',
      inputSchema: strictInput({
        uri: z.string().describe('yaar:// URI to describe'),
      }),
      _meta: LARGE_RESULT_META,
    },
    async ({ uri }) => exec(reg, 'describe', uri),
  );

  server.registerTool(
    'read',
    {
      description:
        'Read the current value/state of a yaar:// resource. ' +
        'For text files and window state, optionally filter by line range, regex pattern, or ' +
        'character range (elsewhere the filter is ignored, with a note saying so).',
      inputSchema: strictInput({
        uri: z.string().describe('yaar:// URI to read'),
        lines: z
          .string()
          .optional()
          .describe('Line range to read (1-based, inclusive). E.g. "10-20", "50", "100-"'),
        pattern: z
          .string()
          .optional()
          .describe(
            'Regex pattern — returns only matching lines with line numbers. On an object/array ' +
              'window state (without `lines`) it searches one "path: value" line per leaf ' +
              'instead, each path appendable to the read URI',
          ),
        context: z
          .number()
          .optional()
          .describe(
            'Context lines around pattern matches (default: 0); on a state path search, ' +
              'sibling values on each side under the same parent',
          ),
        chars: z
          .string()
          .optional()
          .describe(
            'Character range (0-based, end exclusive), e.g. "0-50000", "50000-100000", "150000-". ' +
              'Pages a file that is one huge line, where lines/pattern return all or nothing. ' +
              'Not combinable with lines/pattern.',
          ),
        pdfText: z
          .union([z.boolean(), z.string()])
          .optional()
          .describe('PDF only: the text layer — true, or a page range like "1-3".'),
        pdfPages: z.string().optional().describe('PDF only: pages to rasterize, e.g. "1-3".'),
        pdfScale: z
          .number()
          .min(0.5)
          .max(4)
          .optional()
          .describe(
            'With pdfPages: render scale, 72 DPI × scale (default 1.5); raise for dense pages.',
          ),
        pdfCrop: z
          .strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
          .optional()
          .describe('With pdfPages: render only this region, as page fractions from the top-left.'),
        rawImage: z
          .boolean()
          .optional()
          .describe('Images only: the stored bytes instead of the WebP re-encode.'),
        // The options are spelled out by `describe` on a model and by a plain read of one —
        // a strict bag here keeps a misspelt key refused without their text in every turn.
        gltf: z
          .strictObject({
            node: z.string().optional(),
            depth: z.number().int().min(0).optional(),
            keys: z.string().optional(),
            pose: z.string().optional(),
            at: z.number().optional(),
            range: z.string().optional(),
            step: z.number().positive().optional(),
            euler: z.boolean().optional(),
            omit: z.string().optional(),
          })
          .optional()
          .describe('glTF/GLB only: model summary options — describe the file for what each does.'),
      }),
      _meta: LARGE_RESULT_META,
    },
    async ({
      uri,
      lines,
      pattern,
      context,
      chars,
      pdfText,
      pdfPages,
      pdfScale,
      pdfCrop,
      rawImage,
      gltf,
    }) =>
      exec(reg, 'read', uri, undefined, {
        lines,
        pattern,
        context,
        chars,
        pdfText,
        pdfPages,
        pdfScale,
        pdfCrop,
        rawImage,
        gltf,
        // A read that lands on a folder falls back to list — page it as list would.
        defaultLimit: LIST_PAGE_SIZE,
      }),
  );

  server.registerTool(
    'list',
    {
      description:
        'List child resources under a yaar:// URI. ' +
        `A storage folder returns ${LIST_PAGE_SIZE} entries at a time, with a note giving the ` +
        'total and the next range; sort/order pick which entries come first.',
      inputSchema: strictInput({
        uri: z.string().describe('yaar:// URI to list children of'),
        sort: z
          .enum(['name', 'modified', 'size'])
          .optional()
          .describe(
            'Storage folders: order by name (directories first, the default), last write ' +
              '(each entry then carries modifiedAt), or byte size (files only first).',
          ),
        order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Default "asc" for name, "desc" for modified/size — newest or largest first.'),
        range: z
          .string()
          .optional()
          .describe(
            `Storage folders: which entries to return (1-based, inclusive), e.g. "1-100", ` +
              `"201-400", "500-". Default: the first ${LIST_PAGE_SIZE}.`,
          ),
      }),
      _meta: LARGE_RESULT_META,
    },
    async ({ uri, sort, order, range }) =>
      exec(reg, 'list', uri, undefined, { sort, order, range, defaultLimit: LIST_PAGE_SIZE }),
  );

  server.registerTool(
    'invoke',
    {
      description:
        'Invoke an action on a yaar:// resource (create, update, trigger). ' +
        'Besides brace expansion in the URI (run in parallel), payload accepts an ARRAY to ' +
        'run the same URI once per element, in order, as one call — e.g. ' +
        'invoke(".../commands/setTransform", ' +
        '[{id:"a",...},{id:"b",...}]). Use the array form instead of N identical calls that ' +
        'differ only in their payload. It stops at the first failure and reports the index.',
      inputSchema: strictInput(
        {
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
        { nestUnder: 'payload' },
      ),
      _meta: LARGE_RESULT_META,
    },
    async ({ uri, payload }) => exec(reg, 'invoke', uri, payload),
  );

  server.registerTool(
    'delete',
    {
      description: 'Delete a yaar:// resource.',
      inputSchema: strictInput({
        uri: z.string().describe('yaar:// URI to delete'),
      }),
    },
    async ({ uri }) => exec(reg, 'delete', uri),
  );
}
