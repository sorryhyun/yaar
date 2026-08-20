/**
 * Agent profiles barrel — single import point for all profile consumers.
 *
 * Pure re-exports. Each profile lives in its own directory with a `prompts/`
 * subdir of markdown parts; shared parts live in `./prompts/` and are combined
 * per profile via `compose.ts`.
 */

export type { AgentProfile } from './types.js';
export {
  VERB_TOOL_NAMES,
  VERB_TOOLS,
  APP_AGENT_TOOL_NAMES,
  MESSAGING_TOOL_NAMES,
} from './types.js';

export { composePrompt } from './compose.js';

export { ORCHESTRATOR_PROMPT, getOrchestratorPrompt } from './orchestrator/index.js';
export { SESSION_AGENT_PROFILE } from './session-agent/index.js';
export { buildAppAgentProfile } from './app-agent/index.js';
export { DEVELOPER_PROFILE, getDeveloperAllowedTools } from './developer.js';

export { AGENT_TYPE_MODELS, resolveAgentModel, claudeModelToCodex } from './model-tiers.js';
export { turnOptionsFor, getMonitorTurnOptions, type TurnOptions } from './turn-options.js';
export { CODEX_AGENT_ROLES, codexRoleToToml, type CodexAgentRole } from './codex-roles.js';
