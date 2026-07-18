/**
 * Role-aware system prompt assembly.
 *
 * App agents already receive an app-scoped profile containing their own docs,
 * protocol, and explicitly controllable apps. Global environment and memory
 * belong to orchestrator-style agents and must not leak into that profile.
 */

import type { ProviderType } from '../providers/types.js';
import { buildEnvironmentSection } from '../providers/environment.js';
import { configRead } from '../storage/storage-manager.js';

export interface SystemPromptLoaders {
  buildEnvironment(providerType: ProviderType): Promise<string>;
  loadMemory(): Promise<string>;
}

/** Build a scope section so an agent knows its place in the hierarchy. */
function buildScopeSection(role: string, monitorId?: string): string {
  // Window agent: role is "window-{windowId}" or "window-{windowId}/{actionId}"
  const windowMatch = role.match(/^window-(.+?)(?:\/|$)/);
  if (windowMatch) {
    const windowId = windowMatch[1];
    return `\n\n## Scope\nYou are a **window agent** for \`${windowId}\`. Your actions are limited to this window. Use \`yaar://windows/${windowId}\` to address it.`;
  }

  // Profile-driven agents define their own identity — no generic scope.
  if (role.startsWith('session-') || role.startsWith('app-')) {
    return '';
  }

  // Monitor/ephemeral agent with monitorId
  if (monitorId) {
    return `\n\n## Scope\nYou are the **monitor agent** for \`${monitorId}\`. Use \`yaar://windows/\` URIs to create and manage windows (e.g. \`yaar://windows/my-window\`). The monitor is assigned automatically.`;
  }

  return '';
}

async function loadMemory(): Promise<string> {
  const result = await configRead('memory.md');
  if (!result.success || !result.content?.trim()) {
    return '';
  }
  return `\n\n## Memory\nThe following notes were saved by you from previous sessions:\n${result.content.trim()}`;
}

const DEFAULT_LOADERS: SystemPromptLoaders = {
  buildEnvironment: buildEnvironmentSection,
  loadMemory,
};

/**
 * Assemble a turn's full system prompt.
 *
 * App profiles are deliberately closed over their own app context. In
 * particular, do not load the installed-app roster, other apps' HINT.md files,
 * global storage/mounts, onboarding instructions, or shared memory for them.
 */
export async function assembleSystemPromptForRole(
  basePrompt: string,
  role: string,
  providerType: ProviderType,
  monitorId?: string,
  loaders: SystemPromptLoaders = DEFAULT_LOADERS,
): Promise<string> {
  const scopedPrompt = basePrompt + buildScopeSection(role, monitorId);

  if (role.startsWith('app-')) {
    return scopedPrompt;
  }

  const [memory, environment] = await Promise.all([
    loaders.loadMemory(),
    loaders.buildEnvironment(providerType),
  ]);
  return scopedPrompt + environment + memory;
}
