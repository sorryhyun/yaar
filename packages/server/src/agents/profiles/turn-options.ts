/**
 * Per-turn model + tool-set resolution — the provider-aware half of a profile.
 */

import type { AgentProfile } from './types.js';
import { claudeModelToCodex } from './model-tiers.js';
import { DEVELOPER_PROFILE } from './developer.js';

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
 */
export function getMonitorTurnOptions(providerType: string): TurnOptions {
  return turnOptionsFor(DEVELOPER_PROFILE, providerType);
}
