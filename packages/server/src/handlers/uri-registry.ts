/**
 * ResourceRegistry — URI pattern → handler mapping for the verb layer.
 *
 * Handlers register against URI patterns (exact, prefix, or wildcard)
 * and declare which verbs they support. The registry resolves a URI
 * to the best-matching handler and dispatches verb calls.
 */

import type { ResolvedUri } from './uri-resolve.js';
import { resolveUri } from './uri-resolve.js';

export type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

export interface VerbResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
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

    // describe is always auto-generated
    if (verb === 'describe') {
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
