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

/**
 * Model + tool set a monitor agent's turns run with. Single source for the
 * turn runner (monitor-task-processor) and prewarm (context-pool) so the
 * prewarmed provider stream matches the first real turn exactly.
 */
export function getMonitorTurnOptions(providerType: string): {
  model?: string;
  allowedTools?: string[];
} {
  return providerType === 'codex'
    ? { model: claudeModelToCodex('claude-opus-4-8'), allowedTools: undefined }
    : { model: 'claude-opus-4-8', allowedTools: getDeveloperAllowedTools() };
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
