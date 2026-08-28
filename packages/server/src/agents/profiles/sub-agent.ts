/**
 * The sub-agent profile — the one capability set a sub-agent may hold.
 *
 * A sub-agent is the leaf of the agent tree (session → monitor → app → sub-agent):
 * an AI instance whose **system prompt its owning app supplies at runtime**. Every
 * other profile in this directory is an install-time artifact, with the prompt coming
 * off disk (`agent/prompt.md`) or out of a constant. A sub-agent inverts that
 * half, which is exactly why the other half — what it can touch — is nailed shut here
 * rather than left to the caller (law 3 in
 * `docs/architecture/agent_tree.md`: prompts descend toward runtime,
 * capabilities stay at install time).
 *
 * The reach is one thing and only one thing:
 *
 *     send a payload to your OWN app's iframe, and read the reply
 *
 * — over the same request/response bridge the app agent's `command` tool already uses.
 * The spawn-time `tools` array does not widen that; it only decides how many names the
 * single channel wears and what the model is told each one means. Every tool is
 * `mcp__subagent__{name}`, every one of them lands in `mcp/sub-agent/`, and every one
 * of them ends up as one `persona:{name}` command sent to one window — the app's own.
 * There is no spelling of the tools array that reaches a YAAR verb, another app, the
 * filesystem, or the network.
 *
 * That is also why the reach is monotone with respect to the owner (law 2): the app
 * agent's `command` tool can dispatch *any* command to that iframe, so a sub-agent
 * that can dispatch a named subset is strictly less able than the app agent above it.
 *
 * A sub-agent spawned with no tools is the plain case — receives text, returns text,
 * holds nothing — and is what an app that just wants a cast of characters gets by
 * omitting `tools` entirely.
 */

import type { AgentProfile } from './types.js';
import { SUB_AGENT_ROLE_PREFIX } from '@yaar/shared';

/** Max characters of caller-supplied prompt accepted. Generous; a guard, not a budget. */
export const MAX_SUB_AGENT_PROMPT_CHARS = 20_000;

/** Sub-agent ids are used in URIs, keys, and role strings — keep them boring. */
export const SUB_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// ── The one channel ─────────────────────────────────────────────────────────

/**
 * The MCP namespace every sub-agent tool lives in.
 *
 * One namespace for all of them on purpose: `buildSDKOptions` derives the connected
 * MCP server set from the tool allowlist (`mcp__(\w+)__`), so a sub-agent whose
 * allowlist holds only `mcp__subagent__*` connects exactly one server — the one whose
 * every tool is a name over the bridge to its own app. Splitting the tools across
 * namespaces would mean nothing; adding a YAAR namespace to that allowlist would mean
 * everything, which is why the allowlist is built from this constant rather than
 * accepted from the caller.
 */
export const SUB_AGENT_MCP_SERVER = 'subagent';

/** `skip` → `mcp__subagent__skip`. The only shape a sub-agent tool name may take. */
export function subAgentToolName(tool: string): string {
  return `mcp__${SUB_AGENT_MCP_SERVER}__${tool}`;
}

/**
 * Tool names become MCP tool names and `persona:{name}` protocol commands, so they
 * are held to the intersection of what both accept: letters, digits, `_`, no colons.
 */
export const SUB_AGENT_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** Parameter names ride in a JSON payload and a Zod shape — same boring rule. */
export const SUB_AGENT_PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/**
 * How many tools one spawn may define, and how many characters they may spend
 * between them (names + descriptions + parameter descriptions).
 *
 * The sibling of {@link MAX_SUB_AGENT_PROMPT_CHARS}, for the same reason: a tool list
 * is prompt material, it is replayed on every turn, and an app that pastes a novel
 * into it costs tokens on every message rather than failing loudly once. Generous
 * enough that no real cast of tools comes near it.
 */
export const MAX_SUB_AGENT_TOOLS = 12;
export const MAX_SUB_AGENT_TOOL_CHARS = 6_000;

/** The JSON types a spawn-time parameter may declare. */
export const SUB_AGENT_PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type SubAgentParamType = (typeof SUB_AGENT_PARAM_TYPES)[number];

/**
 * One parameter of an app-defined tool.
 *
 * Shorthand (`{ fact: 'string' }`) is the common case; the object form exists for the
 * parameter that needs a sentence of its own or is optional.
 */
export interface SubAgentToolParam {
  type: SubAgentParamType;
  description?: string;
  optional?: boolean;
}

/** One app-defined tool: a costume over the single bridge channel. */
export interface SubAgentToolSpec {
  name: string;
  description: string;
  input?: Record<string, SubAgentToolParam>;
}

/**
 * Normalize one spawn-supplied tool entry, or say why it is not one.
 *
 * Validation lives here rather than in the verb handler because the shape it accepts
 * *is* the contract — the handler owns the wording of the refusal, this owns what may
 * be built.
 */
export function parseToolSpec(raw: unknown): { tool: SubAgentToolSpec } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'each entry of "tools" must be an object { name, description, input? }.' };
  }
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!SUB_AGENT_TOOL_NAME_RE.test(name)) {
    return {
      error: `invalid tool name "${name}". Use letters, digits and "_" (max 48, must start with a letter).`,
    };
  }
  const description = typeof entry.description === 'string' ? entry.description.trim() : '';
  if (!description) {
    return {
      error: `tool "${name}" needs a "description" — it is the only thing the sub-agent reads to decide when to use it.`,
    };
  }

  const tool: SubAgentToolSpec = { name, description };

  if (entry.input !== undefined) {
    if (!entry.input || typeof entry.input !== 'object' || Array.isArray(entry.input)) {
      return { error: `tool "${name}": "input" must be an object of { paramName: type }.` };
    }
    const input: Record<string, SubAgentToolParam> = {};
    for (const [param, spec] of Object.entries(entry.input as Record<string, unknown>)) {
      if (!SUB_AGENT_PARAM_NAME_RE.test(param)) {
        return { error: `tool "${name}": invalid parameter name "${param}".` };
      }
      const parsed = parseParam(spec);
      if (!parsed) {
        return {
          error:
            `tool "${name}", parameter "${param}": type must be one of ` +
            `${SUB_AGENT_PARAM_TYPES.join(', ')} (or { type, description?, optional? }).`,
        };
      }
      input[param] = parsed;
    }
    if (Object.keys(input).length > 0) tool.input = input;
  }

  return { tool };
}

function parseParam(spec: unknown): SubAgentToolParam | null {
  const types = SUB_AGENT_PARAM_TYPES as readonly string[];
  if (typeof spec === 'string') {
    return types.includes(spec) ? { type: spec as SubAgentParamType } : null;
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const obj = spec as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !types.includes(obj.type)) return null;
  return {
    type: obj.type as SubAgentParamType,
    ...(typeof obj.description === 'string' && obj.description
      ? { description: obj.description }
      : {}),
    ...(obj.optional === true ? { optional: true } : {}),
  };
}

/** Characters a tool list spends on prompt material — measured against the cap. */
export function toolSpecChars(tools: SubAgentToolSpec[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length + tool.description.length;
    for (const [param, spec] of Object.entries(tool.input ?? {})) {
      chars += param.length + spec.type.length + (spec.description?.length ?? 0);
    }
  }
  return chars;
}

// ── Roles ───────────────────────────────────────────────────────────────────

/**
 * The prefix of every sub-agent's per-turn role string. Defined in `@yaar/shared`
 * alongside the other role prefixes (the client reads a tier off a role too) and
 * re-exported here, where everything that mints or matches it lives.
 *
 * Must start with `app-`, and that is load-bearing in three places: it is what
 * `assembleSystemPromptForRole` keys on to return the prompt **verbatim** (no
 * environment section, no memory, no scope blurb — which is what makes a sub-agent
 * *be* its prompt rather than a YAAR agent wearing one), what `principalRole()` keys
 * on to file the turn in the unprivileged `app` tier, and — via {@link isSubAgentRole}
 * — what keeps the turn out of the monitor agent's restored context.
 *
 * `persona` rather than `subagent` because that is the shipped vocabulary this tier
 * already speaks: the URI segment, the spawn param, and the `persona:` command prefix
 * all say persona, and a role string is the one of the four nobody reads but the log.
 */
export { SUB_AGENT_ROLE_PREFIX };

export function subAgentRole(appId: string, subId: string): string {
  return `${SUB_AGENT_ROLE_PREFIX}${appId}-${subId}`;
}

/**
 * True for a role string minted by {@link subAgentRole}.
 *
 * `logging/context-restore.ts` is the consumer that matters: a sub-agent holds no
 * context tape and no window, so its turns are logged under the *monitor's* source —
 * the same source the real user↔monitor conversation uses — and the restore filter
 * keys on source alone. Without this predicate, reloading a session replays every
 * character's in-character line into the monitor agent's history as if the user had
 * said it. A prefix test rather than a parse: appIds and subIds both contain `-`, so
 * `app-persona-a-b-c` is genuinely ambiguous and nothing downstream needs the parts.
 */
export function isSubAgentRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && role.startsWith(SUB_AGENT_ROLE_PREFIX);
}

// ── Profile ─────────────────────────────────────────────────────────────────

/** Everything a profile needs to know about the node it is being built for. */
export interface SubAgentSpec {
  appId: string;
  subId: string;
  systemPrompt: string;
  model?: string;
  /** The app-defined tools this node was spawned with. Empty for a tool-less one. */
  tools?: SubAgentToolSpec[];
}

/**
 * Build a sub-agent's profile: the caller's prompt, and an allowlist of exactly the
 * bridge tools it declared.
 *
 * Two things here are the whole containment story, and both are easy to undo by
 * accident:
 *
 * 1. **The allowlist is *derived* from the tool names, never taken from the caller.**
 *    `buildSDKOptions` reads it as an allowlist and connects only the MCP servers it
 *    names, so the process this profile starts can reach the `subagent` namespace and
 *    nothing else — no `verbs`, no `app`, no `messaging`, no `WebSearch`, no `Task`.
 * 2. **An empty `tools` yields `allowedTools: []`, not `undefined`.** Empty means *no
 *    MCP servers are even connected*; `undefined` would mean every tool YAAR has
 *    (`buildSDKOptions`: `allowedTools ?? getToolNames()`). A tool-less sub-agent is
 *    the common case, so this is the branch that must not rot.
 *
 * `systemPrompt` is used verbatim — no preamble, no appended house rules. The caller
 * is an app describing a character; anything appended here leaks YAAR's voice into it.
 *
 * Every sub-agent turn goes through here (`SubAgentRegistry.runTurn` rebuilds the
 * profile per turn), so the turn's `allowedTools` come from this function and never
 * from the call site.
 */
export function buildSubAgentProfile(spec: SubAgentSpec): AgentProfile {
  return {
    id: `subagent-${spec.appId}-${spec.subId}`,
    description: `Sub-agent "${spec.subId}" of app ${spec.appId}`,
    systemPrompt: spec.systemPrompt,
    allowedTools: (spec.tools ?? []).map((t) => subAgentToolName(t.name)),
    ...(spec.model ? { model: spec.model } : {}),
  };
}
