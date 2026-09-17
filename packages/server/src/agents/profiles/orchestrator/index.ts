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
import taskList from '../prompts/task-list.md' with { type: 'text' };

import intro from './prompts/intro.md' with { type: 'text' };
import builtinTools from './prompts/builtin-tools.md' with { type: 'text' };
import timeline from './prompts/timeline.md' with { type: 'text' };
import apps from './prompts/apps.md' with { type: 'text' };
import drawings from './prompts/drawings.md' with { type: 'text' };
import config from './prompts/config.md' with { type: 'text' };
import reloadCache from './prompts/reload-cache.md' with { type: 'text' };
import remoteControl from './prompts/remote-control.md' with { type: 'text' };
import remoteIntro from './prompts/remote-intro.md' with { type: 'text' };
import remoteVisibility from './prompts/remote-visibility.md' with { type: 'text' };

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
 * The monitor agent's prompt for a hosted Remote Control session
 * (`features/remote-control/agent-config.ts`).
 *
 * Same platform reference, different situation. The user reads the chat reply on
 * claude.ai/code rather than the desktop, and none of the per-turn context the local
 * monitor is fed ever arrives — no timeline, no `<reload_options>`, no drawings, no relays
 * — so the parts that describe that context are left out rather than contradicted, and
 * so is this agent's own door to starting Remote Control. Visibility and user prompts
 * both assume someone at the desktop and are replaced by one remote section.
 */
export const REMOTE_ORCHESTRATOR_PROMPT = composePrompt(
  remoteIntro,
  verbTools,
  payloadLiterals,
  uriNamespaces,
  remoteVisibility,
  taskList,
  windows,
  storage,
  http,
  mcp,
  apps,
  skills,
  config,
);

const customPrompt = loadCustomSystemPrompt();

export function getOrchestratorPrompt(): string {
  return customPrompt ?? ORCHESTRATOR_PROMPT;
}

/** A custom prompt replaces the platform reference, so it still gets the remote framing. */
export function getRemoteOrchestratorPrompt(): string {
  return customPrompt
    ? composePrompt(remoteIntro, customPrompt, remoteVisibility)
    : REMOTE_ORCHESTRATOR_PROMPT;
}
