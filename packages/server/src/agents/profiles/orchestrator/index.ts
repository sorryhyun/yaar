/**
 * Orchestrator (monitor agent) system prompt.
 *
 * Lean routing-focused prompt. The orchestrator understands intent,
 * decides approach, and dispatches work to specialist sub-agents.
 * Detailed domain knowledge lives in the specialist profiles.
 *
 * The prompt is composed from parts (see `../compose.ts`): its own prose under
 * `./prompts/`, platform reference shared with other profiles under `../prompts/`.
 * The argument list below is the declaration of which parts it uses, in order.
 */

import { loadCustomSystemPrompt } from '../../../providers/load-system-prompt.js';
import { composePrompt } from '../compose.js';

import verbTools from '../prompts/verb-tools.md' with { type: 'text' };
import payloadLiterals from '../prompts/payload-literals.md' with { type: 'text' };
import uriNamespaces from '../prompts/uri-namespaces.md' with { type: 'text' };
import visibility from '../prompts/visibility.md' with { type: 'text' };
import windows from '../prompts/windows.md' with { type: 'text' };
import storage from '../prompts/storage.md' with { type: 'text' };
import http from '../prompts/http.md' with { type: 'text' };
import mcp from '../prompts/mcp.md' with { type: 'text' };
import skills from '../prompts/skills.md' with { type: 'text' };
import userPrompts from '../prompts/user-prompts.md' with { type: 'text' };

import intro from './prompts/intro.md' with { type: 'text' };
import builtinTools from './prompts/builtin-tools.md' with { type: 'text' };
import role from './prompts/role.md' with { type: 'text' };
import timeline from './prompts/timeline.md' with { type: 'text' };
import apps from './prompts/apps.md' with { type: 'text' };
import drawings from './prompts/drawings.md' with { type: 'text' };
import config from './prompts/config.md' with { type: 'text' };
import reloadCache from './prompts/reload-cache.md' with { type: 'text' };

export const ORCHESTRATOR_PROMPT = composePrompt(
  intro,
  verbTools,
  builtinTools,
  payloadLiterals,
  uriNamespaces,
  visibility,
  role,
  windows,
  storage,
  http,
  mcp,
  timeline,
  apps,
  skills,
  drawings,
  config,
  userPrompts,
  reloadCache,
);

const customPrompt = loadCustomSystemPrompt();

export function getOrchestratorPrompt(): string {
  return customPrompt ?? ORCHESTRATOR_PROMPT;
}
