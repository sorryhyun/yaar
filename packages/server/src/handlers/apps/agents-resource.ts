/**
 * `yaar://apps/{appId}/agents[/{personaId}]` — an app's own persona agents.
 *
 * Reached only through the composite `yaar://apps/*` handler in `register.ts` (the
 * registry has no middle wildcard). Each entry point returns `null` for a non-persona
 * URI so the composite can fall through to storage, db, or the app itself.
 *
 *   list  ('yaar://apps/self/agents')                                   → roster
 *   invoke('yaar://apps/self/agents', { action: 'spawn', personaId, systemPrompt, model? })
 *   invoke('yaar://apps/self/agents/{id}', { action: 'message', content })
 *   invoke('yaar://apps/self/agents/{id}', { action: 'interrupt' })
 *   read  ('yaar://apps/self/agents/{id}')                              → status + last answer
 *   delete('yaar://apps/self/agents/{id}')                              → dispose one
 *   delete('yaar://apps/self/agents')                                   → dispose all
 *
 * ## Ownership
 *
 * `self` is resolved to the caller's real appId by the door it came through
 * (`routes/verb.ts` for an iframe), so by the time a URI reaches here it names a
 * concrete app — and naming one is not the same as owning it. Every entry point
 * runs {@link resolveScope}, which requires the appId in the URI to equal the appId
 * the *context* says the caller is. An app therefore cannot reach another app's
 * personas even if it declares `yaar://apps/other/agents` in its permissions and
 * the access chokepoint lets the URI through: the permission list says what you may
 * ask for, this says whose personas they are.
 *
 * A caller with no appId in context — the desktop, an agent turn, anything that is
 * not an app iframe — owns no personas and is refused outright. That is deliberate
 * rather than incidental: personas are an app-owned resource with no monitor- or
 * session-tier equivalent, and there is no principal above them to inherit one.
 */

import type { VerbResult } from '../uri-registry.js';
import type { ResolvedUri } from '../uri-resolve.js';
import { okJson, error, getActivePool, NoActiveSessionError } from '../utils.js';
import { parseAppAgentsPath } from './paths.js';
import { getAppId, requireMonitorId } from '../../agents/agent-context.js';
import { getAppMeta, subAgentDenialReason } from '../../features/apps/discovery.js';
import { buildAgentStreamUri } from '../../streams/agent-stream.js';
import {
  parseToolSpec,
  toolSpecChars,
  MAX_SUB_AGENT_PROMPT_CHARS,
  MAX_SUB_AGENT_TOOLS,
  MAX_SUB_AGENT_TOOL_CHARS,
  SUB_AGENT_ID_RE,
  type SubAgentToolSpec,
} from '../../agents/profiles/sub-agent.js';
import type { AgentPool, SubAgent } from '../../agents/agent-pool.js';
import { genId } from '../../lib/ids.js';

const DESCRIBE = {
  description:
    'This app\'s sub-agents ("personas") — AI instances with a system prompt you supply at ' +
    'runtime. Each is a real provider session with its own conversation memory, and each ' +
    'streams token-by-token at yaar://agents/{instanceId}/stream (subscribe with mode:"stream"; ' +
    'requires "streams": ["agents"] in app.json). Requires "personas": { "max": N } — or ' +
    '"subagents": { "max": N } — in app.json. None of them hold YAAR verbs, permissions, or a ' +
    'principal. Spawned without "tools" one receives text and returns text; spawned with them ' +
    'it may call each declared tool, which is dispatched to YOUR OWN iframe as the command ' +
    'persona:{toolName} (with personaId in params) and answers with whatever your handler returns.',
  verbs: ['read', 'list', 'invoke', 'delete'],
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['spawn', 'message', 'interrupt'],
        description:
          'spawn (on the collection) creates a sub-agent; message/interrupt address one.',
      },
      personaId: {
        type: 'string',
        description: 'For spawn: the id to register the sub-agent under. [A-Za-z0-9_-], max 64.',
      },
      systemPrompt: {
        type: 'string',
        description: "For spawn: the sub-agent's system prompt, used verbatim.",
      },
      tools: {
        type: 'array',
        description:
          'For spawn: the tools this sub-agent may call, each { name, description, input?: ' +
          '{ param: "string"|"number"|"boolean"|"object"|"array" } }. Calling one sends ' +
          'persona:{name} to your iframe; register a handler for it. Omit for a tool-less ' +
          'sub-agent that just receives text and returns text.',
        items: { type: 'object' },
      },
      model: { type: 'string', description: 'For spawn: optional model override.' },
      content: { type: 'string', description: 'For message: the text to send to the sub-agent.' },
    },
  },
};

/**
 * What a persona looks like over the wire. Same shape from `list` and `read`.
 *
 * This function, and the `personaId` reads below it, are where the pool's `subId`
 * becomes the wire's `personaId`. The translation lives here on purpose: `personaId`
 * is shipped format, and the pool's own field should not be named for the URI that
 * happens to address it.
 */
function personaView(p: SubAgent, pool: AgentPool): Record<string, unknown> {
  return {
    personaId: p.subId,
    instanceId: p.agent.instanceId,
    streamUri: buildAgentStreamUri(p.agent.instanceId),
    busy: pool.isSubAgentBusy(p),
    createdAt: p.createdAt,
    ...(p.model ? { model: p.model } : {}),
    ...(p.tools.length > 0 ? { tools: p.tools.map((t) => t.name) } : {}),
    ...(p.lastResponse !== undefined ? { lastResponse: p.lastResponse } : {}),
  };
}

interface Scope {
  appId: string;
  personaId?: string;
  monitorId: string;
  /**
   * The pool, resolved on first use rather than up front.
   *
   * `getActivePool()` reaches `getActiveSession()`, which *throws* `NoActiveSessionError`
   * when the hub has no session — and the verb route turns that throw into a retryable
   * 503, correctly, since an iframe can boot before the desktop's socket connects.
   * Resolving it eagerly here made every refusal inherit that: a spawn with a malformed
   * personaId came back as "try again later" instead of "fix the id", and the app dutifully
   * retried a call that could never succeed. Argument validation now happens first and
   * answers for itself; only a call that really needs the pool asks for one.
   */
  pool: () => AgentPool;
  /** Per-(monitor, app) ceiling from the manifest. Always > 0 once resolved. */
  max: number;
}

/**
 * Resolve a persona URI to the caller's own scope, or explain why it isn't theirs.
 *
 * Returns `null` for a URI this resource does not own (the composite falls through),
 * a `VerbResult` error for one it owns but the caller may not use, and a {@link Scope}
 * otherwise.
 */
async function resolveScope(uri: string): Promise<Scope | VerbResult | null> {
  const parsed = parseAppAgentsPath(uri);
  if (!parsed) return null;

  const callerAppId = getAppId();
  if (!callerAppId) {
    return error(
      'Persona agents are app-owned. This call carries no app identity — it must come from ' +
        "an app's iframe (POST /api/verb with an iframe token).",
    );
  }
  if (callerAppId !== parsed.appId) {
    return error(
      `App "${callerAppId}" cannot reach app "${parsed.appId}"'s personas. Use yaar://apps/self/agents.`,
    );
  }

  const meta = await getAppMeta(parsed.appId);
  const declared = meta?.subagents;
  if (!declared || declared.max <= 0) {
    // Three failures that used to read identically — see `subAgentDenialReason`. The
    // original bug was this message telling an author to add a field their app.json
    // already had; each branch here names the fix that actually applies.
    const reason = await subAgentDenialReason(parsed.appId);
    return error(
      reason === 'retired-key'
        ? `App "${parsed.appId}" declares "personas", which is no longer read. Rename it to ` +
            '"subagents": { "max": N } in app.json. Only the manifest key changed — the wire ' +
            'still says personaId.'
        : reason === 'not-approved'
          ? `App "${parsed.appId}" declares subagents but has not been granted them. Installed ` +
            'apps get this from the user at install time — reinstall or update it from the ' +
            'market and approve the request.'
          : `App "${parsed.appId}" may not spawn personas. Add "subagents": { "max": N } to its ` +
            'app.json.',
    );
  }

  return {
    appId: parsed.appId,
    ...(parsed.personaId ? { personaId: parsed.personaId } : {}),
    // The iframe's own window pins the monitor, so a persona is spawned on the desktop
    // the app is actually running on and can never be addressed from another.
    monitorId: requireMonitorId(),
    pool: () => {
      const pool = getActivePool();
      if (!pool) throw new NoActiveSessionError();
      return pool.agentPool;
    },
    max: declared.max,
  };
}

/** Narrowing helper — a `VerbResult` came back from `resolveScope` instead of a scope. */
function isVerbResult(value: Scope | VerbResult): value is VerbResult {
  return 'content' in value;
}

/** Look up the addressed persona, or the error explaining that it isn't there. */
function requirePersona(scope: Scope): SubAgent | VerbResult {
  if (!scope.personaId) {
    return error('This action addresses one persona: yaar://apps/self/agents/{personaId}.');
  }
  const record = scope.pool().getSubAgent(scope.monitorId, scope.appId, scope.personaId);
  if (!record) {
    return error(
      `No persona "${scope.personaId}" — spawn it first with ` +
        `invoke('yaar://apps/self/agents', { action: 'spawn', personaId, systemPrompt }).`,
    );
  }
  return record;
}

export function describePersonas(uri: string): VerbResult | null {
  if (!parseAppAgentsPath(uri)) return null;
  return okJson({ uri, ...DESCRIBE });
}

export async function listPersonas(resolved: ResolvedUri): Promise<VerbResult | null> {
  const scope = await resolveScope(resolved.sourceUri);
  if (scope === null) return null;
  if (isVerbResult(scope)) return scope;

  const personas = scope.pool().listSubAgents(scope.monitorId, scope.appId);
  return okJson({
    max: scope.max,
    personas: personas.map((p) => personaView(p, scope.pool())),
  });
}

export async function readPersonas(resolved: ResolvedUri): Promise<VerbResult | null> {
  const scope = await resolveScope(resolved.sourceUri);
  if (scope === null) return null;
  if (isVerbResult(scope)) return scope;

  // A bare collection read is the roster — same answer as `list`, since a caller
  // reaching for "what personas do I have" shouldn't have to know which verb we
  // filed it under.
  if (!scope.personaId) return listPersonas(resolved);

  const record = requirePersona(scope);
  if ('content' in record) return record;
  return okJson(personaView(record, scope.pool()));
}

export async function invokePersonas(
  resolved: ResolvedUri,
  payload?: Record<string, unknown>,
): Promise<VerbResult | null> {
  const scope = await resolveScope(resolved.sourceUri);
  if (scope === null) return null;
  if (isVerbResult(scope)) return scope;

  const action = typeof payload?.action === 'string' ? payload.action : '';

  switch (action) {
    case 'spawn':
      return spawn(scope, payload);
    case 'message':
      return message(scope, payload);
    case 'interrupt': {
      const record = requirePersona(scope);
      if ('content' in record) return record;
      // The same `isRunning()` guard every other interrupt door applies
      // (`AgentPool.interruptAll`, `handlers/agents.ts`), and for the reason
      // `interruptAll`'s doc gives: interrupting an idle agent is not free. A
      // prewarmed Claude sub-agent holds an open stream, and this took
      // `closePersistentSession()` on it — so an app polling `interrupt` on a
      // finished sub-agent paid a cold start for its next message, and left a stale
      // `markInterrupted` that swallowed the first action of the turn after it.
      if (!record.agent.session.isRunning()) {
        return okJson({ personaId: record.subId, interrupted: false });
      }
      await record.agent.session.interrupt();
      return okJson({ personaId: record.subId, interrupted: true });
    }
    default:
      return error(`Unknown action "${action}". Use "spawn", "message", or "interrupt".`);
  }
}

/** Validate the spawn's tool list, or explain what's wrong with it. */
function resolveTools(raw: unknown): SubAgentToolSpec[] | VerbResult {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return error('"tools" must be an array of { name, description }.');
  if (raw.length > MAX_SUB_AGENT_TOOLS) {
    return error(`"tools" has ${raw.length} entries; the limit is ${MAX_SUB_AGENT_TOOLS}.`);
  }

  const tools: SubAgentToolSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseToolSpec(entry);
    if ('error' in parsed) return error(`Invalid "tools": ${parsed.error}`);
    if (seen.has(parsed.tool.name)) {
      return error(`Invalid "tools": duplicate tool name "${parsed.tool.name}".`);
    }
    seen.add(parsed.tool.name);
    tools.push(parsed.tool);
  }

  // The sibling of the prompt cap, and there for the same reason: tool definitions are
  // replayed on every turn, so a novel in a description is a per-message cost.
  const chars = toolSpecChars(tools);
  if (chars > MAX_SUB_AGENT_TOOL_CHARS) {
    return error(`"tools" spends ${chars} chars; the limit is ${MAX_SUB_AGENT_TOOL_CHARS}.`);
  }
  return tools;
}

async function spawn(scope: Scope, payload?: Record<string, unknown>): Promise<VerbResult> {
  const personaId = typeof payload?.personaId === 'string' ? payload.personaId.trim() : '';
  const systemPrompt = typeof payload?.systemPrompt === 'string' ? payload.systemPrompt : '';
  const model = typeof payload?.model === 'string' && payload.model ? payload.model : undefined;

  if (!SUB_AGENT_ID_RE.test(personaId)) {
    return error(
      `Invalid personaId "${personaId}". Use letters, digits, "_" or "-" (max 64, must start alphanumeric).`,
    );
  }
  if (!systemPrompt.trim()) {
    return error('"systemPrompt" is required — it is what makes the persona a persona.');
  }
  if (systemPrompt.length > MAX_SUB_AGENT_PROMPT_CHARS) {
    return error(
      `"systemPrompt" is ${systemPrompt.length} chars; the limit is ${MAX_SUB_AGENT_PROMPT_CHARS}.`,
    );
  }

  const tools = resolveTools(payload?.tools);
  if (!Array.isArray(tools)) return tools;

  // Existence, the per-app cap, and the spawn itself are one atomic decision inside
  // the pool — deliberately not three steps here. Split across an await, two spawns in
  // one tick each passed the checks and one of the two agents ended up in no
  // collection at all, holding a provider and a `MAX_AGENTS` slot forever. This layer
  // owns the manifest (hence `max`) and the wording; the pool owns the invariant, and
  // `profiles/sub-agent.ts` owns what a sub-agent can touch.
  const result = await scope.pool().spawnSubAgent(scope.monitorId, scope.appId, personaId, {
    systemPrompt,
    max: scope.max,
    ...(tools.length > 0 ? { tools } : {}),
    ...(model ? { model } : {}),
  });

  switch (result.status) {
    // Idempotent by design. An iframe reload re-runs the app's spawn calls, and the
    // personas from before the reload are still alive with their memory intact — the
    // right answer is to hand back the ones that exist, not to refuse the app its own
    // cast or to silently reset four conversations. The prompt is deliberately *not*
    // updated: it is replayed on every turn, so changing it under a live conversation
    // would rewrite who the persona has been all along. Delete and respawn to recast.
    case 'reused':
      return okJson({ ...personaView(result.record, scope.pool()), reused: true });
    case 'created':
      return okJson(personaView(result.record, scope.pool()));
    case 'at-capacity':
      return error(
        `Persona limit reached: "${scope.appId}" allows ${scope.max} at a time. ` +
          'Delete one first, or raise "personas".max in app.json.',
      );
    case 'no-slot':
      return error(
        'Agent limit reached — no provider slot is free for a new persona. Close an app window ' +
          'or delete a persona and try again (raise MAX_AGENTS to make room permanently).',
      );
  }
}

async function message(scope: Scope, payload?: Record<string, unknown>): Promise<VerbResult> {
  const record = requirePersona(scope);
  if ('content' in record) return record;

  const content = typeof payload?.content === 'string' ? payload.content : '';
  if (!content.trim()) return error('"content" is required for action "message".');

  // Reject rather than queue. A persona's turns are serialized by whoever schedules
  // them — the app's own turn loop — and that scheduler is the only thing that knows
  // whether a second message is a follow-up worth waiting for or a race worth
  // dropping. Queueing here would decide that for it, invisibly. `busy: true` is on
  // the envelope so the caller can branch without parsing the sentence.
  if (scope.pool().isSubAgentBusy(record)) {
    return {
      ...error(`Persona "${record.subId}" is still answering. Interrupt it or wait for done.`),
      structuredContent: { busy: true, personaId: record.subId },
    };
  }

  const taskId = genId('persona');
  // Not awaited: the answer arrives as stream frames, and the verb returns now so the
  // app can fire the next persona in the same tick. A rejection here would otherwise
  // vanish — the turn's own errors reach the caller as `error`/`done` frames, so this
  // only catches a throw before the stream opens.
  void scope
    .pool()
    .runSubAgentTurn(record, content, taskId)
    .catch((err: unknown) => {
      console.error(`[personas] turn failed for ${record.appId}/${record.subId}:`, err);
    });

  return okJson({
    taskId,
    personaId: record.subId,
    instanceId: record.agent.instanceId,
    streamUri: buildAgentStreamUri(record.agent.instanceId),
  });
}

export async function deletePersonas(resolved: ResolvedUri): Promise<VerbResult | null> {
  const scope = await resolveScope(resolved.sourceUri);
  if (scope === null) return null;
  if (isVerbResult(scope)) return scope;

  if (!scope.personaId) {
    const disposed = await scope.pool().disposeSubAgentsForApp(scope.monitorId, scope.appId);
    return okJson({ disposed });
  }

  const ok = await scope.pool().disposeSubAgent(scope.monitorId, scope.appId, scope.personaId);
  if (!ok) return error(`No persona "${scope.personaId}" to delete.`);
  return okJson({ personaId: scope.personaId, disposed: 1 });
}
