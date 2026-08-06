/**
 * Agent profiles barrel — single import point for all profile consumers.
 *
 * Re-exports profile definitions, builder functions, and Codex role config.
 */

import type { AgentProfile } from './types.js';
import { VERB_TOOL_NAMES, MESSAGING_TOOL_NAMES } from './types.js';
import { SYSTEM_TOOL_NAMES } from '../../mcp/system/tool-names.js';
import { claudeModelToCodex } from './model-tiers.js';

// Re-export types and constants
export type { AgentProfile } from './types.js';
export {
  VERB_TOOL_NAMES,
  VERB_TOOLS,
  APP_AGENT_TOOL_NAMES,
  MESSAGING_TOOL_NAMES,
} from './types.js';

// App agent profile builder
export { buildAppAgentProfile } from './app-agent.js';

// Re-export orchestrator
export { ORCHESTRATOR_PROMPT, getOrchestratorPrompt } from './orchestrator.js';

// Re-export session agent profile
export { SESSION_AGENT_PROFILE } from './session-agent.js';

// ── Developer profile (monitor agent) ────────────────────────────────

/**
 * Developer profile — applied to the monitor agent.
 * Acts directly using verbs and delegates browser tasks to the browser app.
 */
export const DEVELOPER_PROFILE: AgentProfile = {
  id: 'developer',
  description: 'Developer agent — acts directly, delegates browser tasks to browser app',
  systemPrompt: '',
  allowedTools: [...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES, ...MESSAGING_TOOL_NAMES],
  // Opus for the monitor agent — it is the one the user talks to. Claude-only; a
  // Codex turn gets the mapped equivalent from `turnOptionsFor`.
  model: 'claude-opus-5',
};

/**
 * Get the developer profile's allowed tools.
 */
export function getDeveloperAllowedTools(): string[] {
  return [...DEVELOPER_PROFILE.allowedTools];
}

// Model capability tiers live in their own module (see model-tiers.ts) and are
// re-exported here so existing consumers keep importing from the barrel.
export { AGENT_TYPE_MODELS, resolveAgentModel, claudeModelToCodex } from './model-tiers.js';

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

// ── Codex agent roles ────────────────────────────────────────────────

export interface CodexAgentRole {
  description?: string;
  modelReasoningEffort?: 'high' | 'medium' | 'low';
  sandboxMode?: string;
  instructions?: string;
}

/**
 * Codex subagent role definitions.
 * Model is inherited from the main AppServerConfig — these control per-role overrides.
 * Each role becomes a TOML config file referenced via `-c agents.<role>.config_file=...`.
 */
export const CODEX_AGENT_ROLES: Record<string, CodexAgentRole> = {
  worker: {
    description: 'Task execution agent',
  },
  explorer: {
    description: 'Fast codebase explorer for read-heavy tasks',
    modelReasoningEffort: 'medium',
    sandboxMode: 'read-only',
  },
};

/**
 * Serialize a Codex agent role to TOML format.
 * The model is passed separately (from AppServerConfig) and prepended.
 */
export function codexRoleToToml(role: CodexAgentRole, model?: string): string {
  const lines: string[] = [];
  if (role.description) lines.push(`description = "${role.description}"`);
  if (model) lines.push(`model = "${model}"`);
  if (role.modelReasoningEffort)
    lines.push(`model_reasoning_effort = "${role.modelReasoningEffort}"`);
  if (role.sandboxMode) lines.push(`sandbox_mode = "${role.sandboxMode}"`);
  if (role.instructions) lines.push(`developer_instructions = "${role.instructions}"`);
  return lines.join('\n') + '\n';
}
