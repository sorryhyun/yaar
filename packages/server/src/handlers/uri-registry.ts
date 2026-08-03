/**
 * ResourceRegistry — URI pattern → handler mapping for the verb layer.
 *
 * Handlers register against URI patterns (exact, prefix, or wildcard)
 * and declare which verbs they support. The registry resolves a URI
 * to the best-matching handler and dispatches verb calls.
 */

import type { ResolvedUri } from './uri-resolve.js';
import { resolveUri } from './uri-resolve.js';
import type { AgentRole } from '../agents/agent-context.js';

/**
 * Injected resolver for the current caller's principal role. Decoupled from
 * agent-context via dependency injection (rather than a direct import) because
 * uri-registry sits inside a large import cycle; a runtime import of
 * agent-context's getters from here mis-links under Bun's module loader.
 * Wired in handlers/index.ts:initRegistry(). Defaults to "no role" → callers
 * are treated as non-session until wired.
 */
let resolveAgentRole: () => AgentRole | undefined = () => undefined;

export function setAccessRoleResolver(fn: () => AgentRole | undefined): void {
  resolveAgentRole = fn;
}

export type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

export interface EmbeddedResourceBlock {
  type: 'resource';
  resource:
    | { uri: string; text: string; mimeType?: string }
    | { uri: string; blob: string; mimeType?: string };
}

export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** Optional resource-specific hint (e.g. app `kind: 'system' | 'app'`). */
  kind?: string;
}

/** One block of a `VerbResult`'s content — the canonical MCP content-block union. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | EmbeddedResourceBlock
  | ResourceLinkBlock;

/** Check if a value is an array of MCP content blocks. */
export function isContentBlocks(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      (((item as Record<string, unknown>).type === 'text' &&
        typeof (item as Record<string, unknown>).text === 'string') ||
        ((item as Record<string, unknown>).type === 'image' &&
          typeof (item as Record<string, unknown>).data === 'string') ||
        ((item as Record<string, unknown>).type === 'resource' &&
          typeof (item as Record<string, unknown>).resource === 'object') ||
        ((item as Record<string, unknown>).type === 'resource_link' &&
          typeof (item as Record<string, unknown>).uri === 'string')),
  );
}

export interface VerbResult {
  content: ContentBlock[];
  isError?: boolean;
  /**
   * Optional lossless, typed copy of the result for programmatic consumers
   * (app→app SDK calls via `POST /api/verb`, non-model MCP clients). `content`
   * remains the model-facing channel — a JSON *string* the LLM reads — while
   * `structuredContent` carries the original object/array untruncated so a
   * downstream reader gets typed data without re-parsing a possibly-truncated
   * text block. Populated by `wrapAppValue` for app object returns; rides through
   * to the MCP `CallToolResult` via the tool handler's `{...result}` spread.
   *
   * Object-only, matching the MCP `structuredContent` contract (and the SDK's
   * `{[x:string]:unknown}` type). Bare-array returns keep their text-only shape and
   * still round-trip through `toEnvelope`'s `tryParseJson`.
   */
  structuredContent?: Record<string, unknown>;
}

export interface DescribeResult {
  uri: string;
  description: string;
  verbs: Verb[];
  invokeSchema?: Record<string, unknown>;
}

/** Optional filtering params for the read verb (ripgrep-style). */
export interface ReadOptions {
  /** Line range to read, e.g. "10-20" or "50" (1-based, inclusive). */
  lines?: string;
  /** Regex pattern to filter matching lines. */
  pattern?: string;
  /** Number of context lines around pattern matches (default: 0). */
  context?: number;
  /**
   * PDF only: extract the text layer. `true` (or "all") reads the whole document; a range
   * string like "1-3" scopes it. Cheapest way to read a text-based PDF.
   */
  pdfText?: boolean | string;
  /**
   * PDF page range to rasterize to images, e.g. "1-3", "5", "2-" (1-based, inclusive) — for
   * scanned/visual PDFs or when layout matters. Omit both pdfText and pdfPages to get document
   * metadata plus a hint to open the PDF in a viewer window — reading a PDF should not ingest
   * its content unless the agent explicitly asks.
   */
  pdfPages?: string;
  /**
   * Images only: return the stored bytes as-is instead of the WebP re-encode a read
   * normally applies before the image enters the context. For when the pixels are the
   * subject rather than the content.
   */
  rawImage?: boolean;
}

/**
 * What `invoke` accepts: one payload, or a list of payloads to run against the same URI
 * in order. Only `ResourceRegistry.execute` ever sees the list form — a handler's
 * `invoke` is always handed one element (see {@link ResourceRegistry.executeBatch}).
 */
export type InvokePayload = Record<string, unknown> | Record<string, unknown>[];

/**
 * Ceiling on a batched invoke. Sized to cover real authoring payloads (a 53-node scene,
 * the ~40 follow-up tweaks that motivated this) while keeping a runaway list from
 * becoming an unbounded sequence of app-command deadlines. Refused with the number in
 * the message, never silently truncated.
 */
const MAX_BATCH_PAYLOADS = 100;

export interface ResourceHandler {
  /** Human-readable description of this resource. */
  description: string;
  /** Which verbs this handler supports (describe is always auto-generated). */
  verbs: Verb[];
  /** Optional JSON schema for invoke payloads. */
  invokeSchema?: Record<string, unknown>;
  /**
   * Optional access requirement. When set to 'session-principal', only the
   * session agent (the user's deputy) may invoke any verb on this resource;
   * all other callers receive a 403-style error. Enforced centrally in
   * ResourceRegistry.execute().
   */
  access?: 'session-principal';

  /**
   * Whether the resource this URI names actually exists.
   *
   * Consulted before the auto-generated `describe`, which otherwise answers about the
   * URI *pattern* and so returns a plausible success for an id that names nothing.
   * Required for `/*` patterns (see {@link ResourceRegistry.register}) — a wildcard is
   * exactly the shape where the id can be wrong. A handler with its own `describe`
   * owns its existence check instead and needs no hook.
   */
  exists?(resolved: ResolvedUri): Promise<boolean>;

  /** Custom describe handler. When provided, called instead of auto-generation. */
  describe?(resolved: ResolvedUri): Promise<VerbResult>;
  read?(resolved: ResolvedUri, options?: ReadOptions): Promise<VerbResult>;
  list?(resolved: ResolvedUri): Promise<VerbResult>;
  invoke?(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult>;
  delete?(resolved: ResolvedUri): Promise<VerbResult>;
}

interface Registration {
  pattern: string;
  handler: ResourceHandler;
  /** 'exact' | 'prefix' | 'wildcard' — determined at registration time. */
  matchType: 'exact' | 'prefix' | 'wildcard';
}

export class ResourceRegistry {
  private registrations: Registration[] = [];

  /**
   * Register a handler for a URI pattern.
   *
   * Pattern types (determined automatically):
   * - Exact:    `yaar://config/settings`
   * - Prefix:   `yaar://config/` (trailing slash)
   * - Wildcard: `yaar://config/*`
   */
  register(pattern: string, handler: ResourceHandler): void {
    let matchType: Registration['matchType'];
    if (pattern.endsWith('/*')) {
      matchType = 'wildcard';
    } else if (pattern.endsWith('/') && pattern !== 'yaar://') {
      matchType = 'prefix';
    } else {
      matchType = 'exact';
    }
    // A wildcard pattern is the one shape where the id can name nothing, so it must
    // say how to tell. Without this, `describe` auto-generates from the *pattern* and
    // answers identically for a live resource and one that has never existed — an
    // optional field nobody remembers is how that got in. Exact and prefix patterns
    // (`yaar://config/`) name a fixed resource and stay exempt.
    if (matchType === 'wildcard' && !handler.exists && !handler.describe) {
      throw new Error(
        `Wildcard handler "${pattern}" must declare exists() or describe() — otherwise ` +
          'describe answers for ids that name no resource.',
      );
    }
    this.registrations.push({ pattern, handler, matchType });
  }

  /**
   * Find the best-matching handler for a URI.
   * Priority: exact > longest prefix > wildcard.
   */
  findHandler(uri: string): ResourceHandler | null {
    let bestMatch: Registration | null = null;
    let bestScore = -1;

    for (const reg of this.registrations) {
      switch (reg.matchType) {
        case 'exact':
          if (uri === reg.pattern) return reg.handler; // exact always wins
          break;

        case 'prefix': {
          // pattern "yaar://config/" matches "yaar://config/settings"
          if (uri.startsWith(reg.pattern) || uri === reg.pattern.slice(0, -1)) {
            const score = reg.pattern.length + 1; // slight priority over wildcard at equal length
            if (score > bestScore) {
              bestScore = score;
              bestMatch = reg;
            }
          }
          break;
        }

        case 'wildcard': {
          // pattern "yaar://config/*" matches anything under yaar://config/
          const prefix = reg.pattern.slice(0, -1); // remove '*'
          if (uri.startsWith(prefix) || uri === prefix.slice(0, -1)) {
            const score = prefix.length;
            if (score > bestScore) {
              bestScore = score;
              bestMatch = reg;
            }
          }
          break;
        }
      }
    }

    return bestMatch?.handler ?? null;
  }

  /**
   * Execute a verb against a URI.
   *
   * An **array** payload runs the same invoke once per element, in order — see
   * {@link ResourceRegistry.executeBatch}. Handlers never see it: each element reaches
   * `handler.invoke` as an ordinary payload, so batching is not something a resource
   * opts into, implements, or can get wrong.
   */
  async execute(
    verb: Verb,
    uri: string,
    payload?: InvokePayload,
    readOptions?: ReadOptions,
  ): Promise<VerbResult> {
    if (Array.isArray(payload)) {
      if (verb !== 'invoke') {
        return {
          content: [
            {
              type: 'text',
              text: `An array payload is only meaningful for invoke — "${verb}" takes one payload or none.`,
            },
          ],
          isError: true,
        };
      }
      return this.executeBatch(uri, payload);
    }

    const handler = this.findHandler(uri);
    if (!handler) {
      return {
        content: [{ type: 'text', text: `No handler registered for URI: ${uri}` }],
        isError: true,
      };
    }

    // Central access control: session-principal resources are reachable only by
    // the session agent. Every other caller (monitor/app agents, apps via
    // /api/verb, contexts with no role) is denied — default-deny.
    if (handler.access === 'session-principal' && resolveAgentRole() !== 'session') {
      return {
        content: [
          {
            type: 'text',
            text: `Access denied (403): ${uri} is restricted to the session agent (the user's deputy).`,
          },
        ],
        isError: true,
      };
    }

    // Trailing-slash normalization: if the URI ends with "/" and matched a wildcard/prefix
    // handler, check if the bare URI (without slash) has a better exact-match handler.
    // e.g., "yaar://apps/" should resolve to the exact "yaar://apps" handler, not "yaar://apps/*".
    if (uri !== 'yaar://' && uri.endsWith('/')) {
      const bareUri = uri.slice(0, -1);
      const bareHandler = this.findHandler(bareUri);
      if (bareHandler && bareHandler !== handler && bareHandler.verbs.includes(verb)) {
        return this.execute(verb, bareUri, payload, readOptions);
      }
    }

    // describe: use custom handler if provided, otherwise auto-generate
    if (verb === 'describe') {
      if (handler.describe) {
        const resolved = resolveUri(uri);
        if (!resolved) {
          return {
            content: [{ type: 'text', text: `Could not resolve URI: ${uri}` }],
            isError: true,
          };
        }
        return handler.describe(resolved);
      }
      // The auto-generated form describes the URI *pattern*, so it is only an honest
      // answer when the URI names something. Ask before generating.
      if (handler.exists) {
        const resolved = resolveUri(uri);
        if (!resolved) {
          return {
            content: [{ type: 'text', text: `Could not resolve URI: ${uri}` }],
            isError: true,
          };
        }
        if (!(await handler.exists(resolved))) {
          return {
            content: [{ type: 'text', text: `No resource at ${uri}.` }],
            isError: true,
          };
        }
      }
      const result: DescribeResult = {
        uri,
        description: handler.description,
        verbs: handler.verbs,
      };
      if (handler.invokeSchema) {
        result.invokeSchema = handler.invokeSchema;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (!handler.verbs.includes(verb)) {
      // Trailing-slash fallback: "yaar://apps/" → retry as "yaar://apps"
      if (uri !== 'yaar://' && uri.endsWith('/')) {
        return this.execute(verb, uri.slice(0, -1), payload, readOptions);
      }
      // Cross-verb fallback: read↔list
      if (verb === 'read' && handler.verbs.includes('list') && handler.list) {
        const resolved = resolveUri(uri);
        if (!resolved)
          return {
            content: [{ type: 'text', text: `Could not resolve URI: ${uri}` }],
            isError: true,
          };
        const result = await handler.list.call(handler, resolved);
        const note = {
          type: 'text' as const,
          text: '(Note: this is a folder/collection — used "list" instead of "read".)',
        };
        return { ...result, content: [note, ...result.content] };
      }
      if (verb === 'list' && handler.verbs.includes('read')) {
        return {
          content: [
            {
              type: 'text',
              text: `"${uri}" is not a folder/collection — use "read" to get its contents.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Verb "${verb}" not supported for URI: ${uri}. Supported: ${handler.verbs.join(', ')}.`,
          },
        ],
        isError: true,
      };
    }

    const resolved = resolveUri(uri);
    if (!resolved) {
      return { content: [{ type: 'text', text: `Could not resolve URI: ${uri}` }], isError: true };
    }

    const method = handler[verb];
    if (!method) {
      return {
        content: [
          {
            type: 'text',
            text: `Handler declares "${verb}" but has no implementation for URI: ${uri}`,
          },
        ],
        isError: true,
      };
    }

    if (verb === 'invoke') {
      return handler.invoke!.call(handler, resolved, payload);
    }
    if (verb === 'read') {
      return handler.read!.call(handler, resolved, readOptions);
    }
    return (method as (resolved: ResolvedUri) => Promise<VerbResult>).call(handler, resolved);
  }

  /**
   * One URI, N payloads, run in order.
   *
   * Brace expansion (`handlers/index.ts`) already batches the other axis — many URIs
   * against one payload, concurrently. This is its complement, and the one that was
   * missing: authoring a scene of 53 nodes takes one `addNodes`, but every subsequent
   * tweak was one call per node because each node needs a *different* payload. Forty
   * tool calls to nudge eyes and socks is the cost this removes.
   *
   * Three decisions, each the conservative reading of "in order":
   *
   * - **Sequential**, unlike brace expansion. Expanded URIs name distinct resources and
   *   cannot interfere; N payloads against *one* resource are edits to one thing, and
   *   running them concurrently would make the result depend on scheduling.
   * - **Stop at the first failure.** The remaining payloads are reported as not
   *   attempted rather than run against a resource that is no longer in the state they
   *   were written for. The index says exactly where to resume.
   * - **Per-element dispatch through `execute`**, so each element is resolved, access-
   *   checked and verb-checked exactly as a lone invoke would be. A batch is a spelling,
   *   never a bypass.
   *
   * Atomicity is deliberately *not* claimed: N elements are N calls, so an app that
   * records undo steps records N of them. Collapsing those into one is the app's to
   * offer through a command that takes a list (`addNodes`), which several already do.
   */
  private async executeBatch(
    uri: string,
    payloads: Record<string, unknown>[],
  ): Promise<VerbResult> {
    if (payloads.length === 0) {
      return {
        content: [
          { type: 'text', text: `Empty payload array for invoke("${uri}") — nothing to do.` },
        ],
        isError: true,
      };
    }
    if (payloads.length > MAX_BATCH_PAYLOADS) {
      return {
        content: [
          {
            type: 'text',
            text:
              `${payloads.length} payloads for invoke("${uri}") exceeds the batch limit of ` +
              `${MAX_BATCH_PAYLOADS}. Split it — each element is a real call, and a batch this ` +
              'long cannot report a partial failure usefully.',
          },
        ],
        isError: true,
      };
    }
    if (payloads.some((p) => !p || typeof p !== 'object' || Array.isArray(p))) {
      return {
        content: [
          {
            type: 'text',
            text: `Every element of a batch payload must be an object — invoke("${uri}") got one that is not.`,
          },
        ],
        isError: true,
      };
    }

    const content: VerbResult['content'] = [];
    for (let i = 0; i < payloads.length; i++) {
      const result = await this.execute('invoke', uri, payloads[i]);
      content.push({ type: 'text', text: `--- [${i}] ---` });
      content.push(...result.content);
      if (result.isError) {
        const remaining = payloads.length - i - 1;
        content.push({
          type: 'text',
          text:
            `Batch stopped at [${i}] of ${payloads.length}: ${i} succeeded` +
            (remaining ? `, ${remaining} not attempted (resend from [${i}]).` : '.'),
        });
        return { content, isError: true };
      }
    }
    content.push({
      type: 'text',
      text: `Batch complete: ${payloads.length} of ${payloads.length}.`,
    });
    return { content };
  }
}
