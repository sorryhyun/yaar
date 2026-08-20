/**
 * Developer profile — applied to the monitor agent.
 * Acts directly using verbs and delegates browser tasks to the browser app.
 *
 * Its `systemPrompt` is empty on purpose: the monitor agent's base prompt is the
 * orchestrator prompt, which the providers load themselves (`getOrchestratorPrompt`).
 */

import type { AgentProfile } from './types.js';
import { VERB_TOOL_NAMES, MESSAGING_TOOL_NAMES } from './types.js';
import { SYSTEM_TOOL_NAMES } from '../../mcp/system/tool-names.js';

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
