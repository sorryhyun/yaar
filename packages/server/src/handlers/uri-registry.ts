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
}

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
   */
  async execute(
    verb: Verb,
    uri: string,
    payload?: Record<string, unknown>,
    readOptions?: ReadOptions,
  ): Promise<VerbResult> {
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
}
