/**
 * Per-turn model + tool-set resolution — the provider-aware half of a profile.
 */

import type { AgentProfile } from './types.js';
import { claudeModelToCodex, FABLE_MODEL } from './model-tiers.js';
import { DEVELOPER_PROFILE } from './developer.js';
import { isFableMode, isSelfCacheManagementEnabled } from '../../config/env.js';
import { REMOVE_CACHE_TOOL_NAMES } from '../../mcp/system/tool-names.js';

export interface TurnOptions {
  model?: string;
  allowedTools?: string[];
}

/**
 * The model and tool set one turn of a profile's agent runs with, for the provider
 * actually in use. Every turn runner goes through here.
 *
 * Two things differ by provider and both are easy to get half-right:
 *
 * - **`allowedTools` must be `undefined` on Codex.** Codex does not filter tools
 *   per-thread — its per-thread `mcp_servers` override selects whole namespaces, not
 *   tools within one (see `codexServerFilter`) — so a Claude-shaped tool list handed
 *   to it is at best ignored. Note `undefined`, not `[]`: an empty array is the
 *   sub-agent tier's containment rule and means *no tools at all*.
 * - **Model names do not transfer.** Profiles name Claude models; Codex needs the
 *   mapped equivalent (`claudeModelToCodex`).
 *
 * Written out independently at three call sites before this existed, and a fourth
 * (`features/agents/session-actions.ts`) passed a Claude tool list to Codex
 * unconditionally.
 */
export function turnOptionsFor(profile: AgentProfile, providerType: string): TurnOptions {
  const isCodex = providerType === 'codex';
  return {
    model: isCodex ? claudeModelToCodex(profile.model) : profile.model,
    allowedTools: isCodex ? undefined : [...profile.allowedTools],
  };
}

/**
 * Monitor-agent turn options. Single source for the turn runner
 * (monitor-task-processor) and prewarm (context-pool) so the prewarmed provider
 * stream matches the first real turn exactly.
 *
 * Fable mode swaps the model here rather than in `DEVELOPER_PROFILE`, so the flag is
 * read per turn and not frozen at import.
 */
export function getMonitorTurnOptions(providerType: string): TurnOptions {
  const profile = isFableMode() ? { ...DEVELOPER_PROFILE, model: FABLE_MODEL } : DEVELOPER_PROFILE;
  return withSelfCacheTool(turnOptionsFor(profile, providerType), 'system');
}

/**
 * Add `remove_cache` while `ENABLE_SELF_CACHE_MANAGEMENT=1`, under the namespace the
 * agent connects — `system` for a monitor agent, `app` for an app agent. Read per turn,
 * like fable mode. A Codex turn has no tool list to add to (`allowedTools` is `undefined`
 * there) and no transcript this could edit, so it is left alone.
 *
 * A wrapper rather than a branch inside `turnOptionsFor` because the name depends on the
 * tier, and a sub-agent's model is resolved through that function too. This list is only
 * what a turn pre-approves; what an agent *sees* is every tool of each namespace it
 * connects, so the session agent, which connects `system`, sees the tool as well.
 */
export function withSelfCacheTool(
  options: TurnOptions,
  namespace: keyof typeof REMOVE_CACHE_TOOL_NAMES,
): TurnOptions {
  if (!options.allowedTools || !isSelfCacheManagementEnabled()) return options;
  return {
    ...options,
    allowedTools: [...options.allowedTools, REMOVE_CACHE_TOOL_NAMES[namespace]],
  };
}
