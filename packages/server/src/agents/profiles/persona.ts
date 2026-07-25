/**
 * Persona profile — a compute-only agent built from a caller-supplied prompt.
 *
 * Every other profile in this directory is an *install-time* artifact: the prompt
 * comes off disk (`AGENTS.md`, `SKILL.md`) or out of a constant, and the code that
 * builds it decides what tools the agent gets. A persona inverts the first half —
 * an app hands in the system prompt at runtime — which is exactly why the second
 * half is nailed shut here rather than left to the caller.
 *
 * `allowedTools: []` is the whole safety story, and it is load-bearing in a way
 * that is easy to undo by accident. `buildSDKOptions` reads it as an allowlist and
 * derives the MCP server set from it (`tool.match(/^mcp__(\w+)__/)`), so an empty
 * list means no MCP servers are even connected, no `WebSearch`, no `Task` — the
 * process starts with nothing to call. `undefined` would mean the opposite: every
 * tool YAAR has. A runtime-supplied system prompt must never get hands, so the
 * empty array is written once, here, and personas are the only tier that has no
 * way to widen it.
 *
 * The `app-` role prefix is the second half of the containment. `assembleSystemPromptForRole`
 * returns an `app-` prompt verbatim (no environment section, no memory, no scope
 * blurb), which is what makes the persona *be* its prompt rather than a YAAR agent
 * wearing one, and `principalRole()` maps it to the unprivileged `app` tier.
 */

import type { AgentProfile } from './types.js';

/** Max characters of caller-supplied prompt accepted. Generous; a guard, not a budget. */
export const MAX_PERSONA_PROMPT_CHARS = 20_000;

/** Persona ids are used in URIs, keys, and role strings — keep them boring. */
export const PERSONA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The per-turn role string for a persona.
 *
 * Must start with `app-`: that prefix is what `assembleSystemPromptForRole` keys
 * on to leave the prompt alone, and what `principalRole` keys on to place the
 * turn in the `app` tier. Renaming it silently re-parents the persona into the
 * monitor tier *and* staples YAAR's environment section onto its prompt.
 */
export function personaRole(appId: string, personaId: string): string {
  return `${PERSONA_ROLE_PREFIX}${appId}-${personaId}`;
}

const PERSONA_ROLE_PREFIX = 'app-persona-';

/**
 * True for a role string minted by {@link personaRole}.
 *
 * Exists because the session log is the one place a persona's turn is written down
 * next to everybody else's, and `logging/context-restore.ts` has to be able to tell
 * them apart. A persona holds no context tape and no window, so its turns carry the
 * *monitor's* source — the same source the real user↔monitor conversation uses — and
 * the restore filter keys on source alone. Without this predicate, reloading a
 * session replays every character's in-character line into the monitor agent's
 * history as if the user had said it.
 *
 * A prefix test rather than a parse: appIds and personaIds both contain `-`, so
 * `app-persona-a-b-c` is genuinely ambiguous and nothing downstream needs the parts.
 */
export function isPersonaRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && role.startsWith(PERSONA_ROLE_PREFIX);
}

/**
 * Build a persona's profile from the prompt its owning app supplied.
 *
 * `systemPrompt` is used verbatim — no preamble, no appended house rules. The
 * caller is an app describing a character; anything appended here leaks YAAR's
 * voice into it.
 */
export function buildPersonaProfile(
  appId: string,
  personaId: string,
  systemPrompt: string,
  model?: string,
): AgentProfile {
  return {
    id: `persona-${appId}-${personaId}`,
    description: `Persona "${personaId}" of app ${appId}`,
    systemPrompt,
    allowedTools: [],
    ...(model ? { model } : {}),
  };
}
