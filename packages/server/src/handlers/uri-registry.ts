/**
 * ResourceRegistry — URI pattern → handler mapping for the verb layer.
 *
 * Handlers register against URI patterns (exact, prefix, or wildcard)
 * and declare which verbs they support. The registry resolves a URI
 * to the best-matching handler and dispatches verb calls.
 */

import type { ResolvedUri } from './uri-resolve.js';
import { resolveUri } from './uri-resolve.js';
import type { AccessPrincipal } from '../agents/agent-context.js';
import { error, ok, prependNote, type VerbResult } from '../lib/verb-result.js';
import { hasLineFilter, type ReadOptions } from '../lib/read-options.js';

/**
 * Injected resolver for the current caller's principal. Decoupled from
 * agent-context via dependency injection (rather than a direct import) because
 * uri-registry sits inside a large import cycle; a runtime import of
 * agent-context's getters from here mis-links under Bun's module loader.
 * Wired in lifecycle.ts. Defaults to the empty principal → callers are treated
 * as neither the session agent nor a system app until wired.
 */
let resolveAccessPrincipal: () => AccessPrincipal = () => ({});

export function setAccessPrincipalResolver(fn: () => AccessPrincipal): void {
  resolveAccessPrincipal = fn;
}

export type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

export interface DescribeResult {
  uri: string;
  description: string;
  verbs: Verb[];
  invokeSchema?: Record<string, unknown>;
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
   * Optional access requirement. When set to 'session-principal', a caller
   * satisfies it iff its role is `session` (the user's deputy) **or** it is a
   * token-backed bundled system app; every other caller receives a 403-style
   * error. Enforced centrally in ResourceRegistry.execute(), which is the
   * authority — it sits behind both doors (MCP and `POST /api/verb`).
   *
   * Never needed under `yaar://session`: `register` applies it to every pattern
   * there whether or not the handler asks (see {@link isSessionPattern}).
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
  /** The access `execute` enforces: the handler's own, or the one its prefix imposes. */
  access: ResourceHandler['access'];
}

/**
 * Is this pattern in the session principal's private namespace?
 *
 * Every such pattern is `session-principal`, derived rather than declared. It used to be
 * a flag each registration set by hand, and `yaar://session/agents` shipped without it:
 * the HTTP door's own `isSessionUri` refusal (http/access.ts) still stopped apps, so
 * nothing looked wrong, but a monitor or app *agent* never passes that door and reached
 * the agent roster and its interrupt/relay/delete. The HTTP check stays as defence in
 * depth; this is the one that covers every caller.
 *
 * There is no weaker access a handler here could ask for — `access` has one value — so
 * deriving it cannot override a deliberate choice; it can only fill in a forgotten one.
 */
export function isSessionPattern(pattern: string): boolean {
  return pattern === 'yaar://session' || pattern.startsWith('yaar://session/');
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
    const access = isSessionPattern(pattern) ? 'session-principal' : handler.access;
    this.registrations.push({ pattern, handler, matchType, access });
  }

  /**
   * Find the best-matching handler for a URI.
   * Priority: exact > longest prefix > wildcard.
   */
  findHandler(uri: string): ResourceHandler | null {
    return this.findRegistration(uri)?.handler ?? null;
  }

  private findRegistration(uri: string): Registration | null {
    let bestMatch: Registration | null = null;
    let bestScore = -1;

    for (const reg of this.registrations) {
      switch (reg.matchType) {
        case 'exact':
          if (uri === reg.pattern) return reg; // exact always wins
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

    return bestMatch;
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
        return error(
          `An array payload is only meaningful for invoke — "${verb}" takes one payload or none.`,
        );
      }
      return this.executeBatch(uri, payload);
    }

    const registration = this.findRegistration(uri);
    if (!registration) {
      return error(`No handler registered for URI: ${uri}`);
    }
    const { handler } = registration;

    // Central access control, and the *authoritative* one: both doors into the verb
    // layer (MCP tools and `POST /api/verb`) end here, so this is the only gate that
    // sees every caller. Two principals satisfy it and nothing else does — default-deny:
    //
    //   - the session agent (`role === 'session'`), the user's deputy;
    //   - a bundled `kind: "system"` app, which carries no agent role but whose token
    //     says what it is. `http/access.ts` has always admitted those to
    //     `yaar://session/*` (`isSessionUri`); before this they were let through one
    //     door and refused at the other, which is why `yaar://session/agents` could only
    //     stay reachable for Process Explorer by going untagged.
    //
    // Everyone else — monitor/app agents, ordinary apps via /api/verb, contexts with no
    // principal at all — is denied.
    const { role, systemApp } = resolveAccessPrincipal();
    if (registration.access === 'session-principal' && role !== 'session' && systemApp !== true) {
      return error(
        `Access denied (403): ${uri} is restricted to the session agent ` +
          "(the user's deputy) and bundled system apps.",
      );
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
          return error(`Could not resolve URI: ${uri}`);
        }
        return handler.describe(resolved);
      }
      // The auto-generated form describes the URI *pattern*, so it is only an honest
      // answer when the URI names something. Ask before generating.
      if (handler.exists) {
        const resolved = resolveUri(uri);
        if (!resolved) {
          return error(`Could not resolve URI: ${uri}`);
        }
        if (!(await handler.exists(resolved))) {
          return error(`No resource at ${uri}.`);
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
      return ok(JSON.stringify(result, null, 2));
    }

    if (!handler.verbs.includes(verb)) {
      // Trailing-slash fallback: "yaar://apps/" → retry as "yaar://apps"
      if (uri !== 'yaar://' && uri.endsWith('/')) {
        return this.execute(verb, uri.slice(0, -1), payload, readOptions);
      }
      // Cross-verb fallback: read↔list
      if (verb === 'read' && handler.verbs.includes('list') && handler.list) {
        const resolved = resolveUri(uri);
        if (!resolved) return error(`Could not resolve URI: ${uri}`);
        const result = await handler.list.call(handler, resolved);
        return prependNote(
          result,
          'Note: this is a folder/collection — used "list" instead of "read".',
        );
      }
      if (verb === 'list' && handler.verbs.includes('read')) {
        return error(`"${uri}" is not a folder/collection — use "read" to get its contents.`);
      }
      return error(
        `Verb "${verb}" not supported for URI: ${uri}. Supported: ${handler.verbs.join(', ')}.`,
      );
    }

    const resolved = resolveUri(uri);
    if (!resolved) {
      return error(`Could not resolve URI: ${uri}`);
    }

    const method = handler[verb];
    if (!method) {
      return error(`Handler declares "${verb}" but has no implementation for URI: ${uri}`);
    }

    if (verb === 'invoke') {
      return handler.invoke!.call(handler, resolved, payload);
    }
    if (verb === 'read') {
      const { readFiltered, ...result } = await handler.read!.call(handler, resolved, readOptions);
      if (readFiltered || result.isError || !hasLineFilter(readOptions)) return result;
      return prependNote(
        result,
        'Note: lines/pattern/chars filtering is not supported for this resource and was ignored — ' +
          'this is the full value.',
      );
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
      return error(`Empty payload array for invoke("${uri}") — nothing to do.`);
    }
    if (payloads.length > MAX_BATCH_PAYLOADS) {
      return error(
        `${payloads.length} payloads for invoke("${uri}") exceeds the batch limit of ` +
          `${MAX_BATCH_PAYLOADS}. Split it — each element is a real call, and a batch this ` +
          'long cannot report a partial failure usefully.',
      );
    }
    if (payloads.some((p) => !p || typeof p !== 'object' || Array.isArray(p))) {
      return error(
        `Every element of a batch payload must be an object — invoke("${uri}") got one that is not.`,
      );
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
