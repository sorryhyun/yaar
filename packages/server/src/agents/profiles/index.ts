/**
 * Agent profiles barrel — single import point for all profile consumers.
 *
 * Re-exports profile definitions, builder functions, and Codex role config.
 */

import type { AgentProfile } from './types.js';
import { VERB_TOOL_NAMES } from './types.js';
import { SYSTEM_TOOL_NAMES } from '../../mcp/system/index.js';

// Re-export types and constants
export type { AgentProfile } from './types.js';
export { VERB_TOOL_NAMES, VERB_TOOLS, APP_AGENT_TOOL_NAMES } from './types.js';

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
  allowedTools: [...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES],
};

/**
 * Get the developer profile's allowed tools.
 */
export function getDeveloperAllowedTools(): string[] {
  return [...DEVELOPER_PROFILE.allowedTools];
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
