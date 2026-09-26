/**
 * Orchestrator (monitor agent) system prompt.
 *
 * The monitor agent acts on the user's requests itself, with its tools, and hands a
 * task to an installed app's agent when one fits.
 *
 * The prompt is composed from parts (see `../compose.ts`): its own prose under
 * `./prompts/`, platform reference shared with other profiles under `../prompts/`.
 * The argument list below is the declaration of which parts it uses, in order.
 */

import { loadCustomSystemPrompt } from '../../load-system-prompt.js';
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
import taskList from '../prompts/task-list.md' with { type: 'text' };

import intro from './prompts/intro.md' with { type: 'text' };
import builtinTools from './prompts/builtin-tools.md' with { type: 'text' };
import timeline from './prompts/timeline.md' with { type: 'text' };
import apps from './prompts/apps.md' with { type: 'text' };
import drawings from './prompts/drawings.md' with { type: 'text' };
import config from './prompts/config.md' with { type: 'text' };
import reloadCache from './prompts/reload-cache.md' with { type: 'text' };
import remoteControl from './prompts/remote-control.md' with { type: 'text' };
import remoteMessage from './prompts/remote-message.md' with { type: 'text' };

export const ORCHESTRATOR_PROMPT = composePrompt(
  intro,
  verbTools,
  builtinTools,
  payloadLiterals,
  uriNamespaces,
  visibility,
  taskList,
  windows,
  storage,
  http,
  mcp,
  timeline,
  apps,
  skills,
  drawings,
  config,
  remoteControl,
  userPrompts,
  reloadCache,
);

/**
 * Leads the context of every message that reaches the monitor agent from claude.ai
 * (Remote Control). The agent's system prompt is the desktop's — it is the same agent, in
 * the same conversation — so what differs about a claude.ai message is said with it.
 */
export const REMOTE_MESSAGE_CONTEXT = remoteMessage;

const customPrompt = loadCustomSystemPrompt();

export function getOrchestratorPrompt(): string {
  return customPrompt ?? ORCHESTRATOR_PROMPT;
}
