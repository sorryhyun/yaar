/**
 * Session agent profile — cross-monitor oversight and coordination.
 *
 * The session agent is a lazy singleton that sits above monitor agents,
 * providing session-wide visibility, mechanical control, and coordination.
 *
 * Prompt parts: its own prose under `./prompts/`, shared platform reference
 * under `../prompts/` (see `../compose.ts`).
 */

import type { AgentProfile } from '../types.js';
import { VERB_TOOL_NAMES, MESSAGING_TOOL_NAMES } from '../types.js';
import { SYSTEM_TOOL_NAMES } from '../../../mcp/system/tool-names.js';
import { composePrompt } from '../compose.js';

import verbTools from '../prompts/verb-tools.md' with { type: 'text' };
import payloadLiterals from '../prompts/payload-literals.md' with { type: 'text' };

import intro from './prompts/intro.md' with { type: 'text' };
import keyUris from './prompts/key-uris.md' with { type: 'text' };
import browserDeputy from './prompts/browser-deputy.md' with { type: 'text' };
import behavior from './prompts/behavior.md' with { type: 'text' };

export const SESSION_AGENT_PROFILE: AgentProfile = {
  id: 'session-agent',
  description: 'Session controller — cross-monitor oversight and coordination',
  systemPrompt: composePrompt(intro, verbTools, payloadLiterals, keyUris, browserDeputy, behavior),
  allowedTools: [...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES, ...MESSAGING_TOOL_NAMES],
  // Opus for the deputy — it oversees/coordinates across monitors and acts as
  // the user. Mirrors the monitor agent's model choice. Claude-only; Codex has
  // no Claude models, so the call site guards on providerType.
  model: 'claude-opus-5',
};
