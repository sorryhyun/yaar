/**
 * Role-aware system prompt assembly.
 *
 * App agents already receive an app-scoped profile containing their own docs,
 * protocol, and explicitly controllable apps. The global environment belongs to
 * orchestrator-style agents and must not leak into that profile.
 */

import type { ProviderType } from '../providers/types.js';
import { buildEnvironmentSection } from '../providers/environment.js';
import { CLAUDE_PROVIDER_SECTION, CODEX_PROVIDER_SECTION } from './profiles/shared-sections.js';
import { isAppRole, isSessionRole } from './roles.js';

export interface SystemPromptLoaders {
  buildEnvironment(providerType: ProviderType): Promise<string>;
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
  if (isSessionRole(role) || isAppRole(role)) {
    return '';
  }

  // Monitor/ephemeral agent with monitorId
  if (monitorId) {
    return `\n\n## Scope\nYou are the **monitor agent** for \`${monitorId}\`. Use \`yaar://windows/\` URIs to create and manage windows (e.g. \`yaar://windows/my-window\`). The monitor is assigned automatically.`;
  }

  return '';
}

/**
 * The one section that differs by model.
 *
 * A provider section corrects a habit one model has and the other does not, so
 * it is selected here rather than written into a profile: the profiles are
 * built at import time, where the provider is not yet known. An empty entry
 * means that model needs no correction and nothing is appended — the section
 * separator is not emitted for it.
 */
function providerSection(providerType: ProviderType): string {
  const section = providerType === 'codex' ? CODEX_PROVIDER_SECTION : CLAUDE_PROVIDER_SECTION;
  return section ? `\n\n${section}` : '';
}

const DEFAULT_LOADERS: SystemPromptLoaders = {
  buildEnvironment: buildEnvironmentSection,
};

/**
 * Assemble a turn's full system prompt.
 *
 * App profiles are deliberately closed over their own app context. In
 * particular, do not load the installed-app roster, other apps' monitor hints,
 * global storage/mounts, or onboarding instructions for them.
 */
export async function assembleSystemPromptForRole(
  basePrompt: string,
  role: string,
  providerType: ProviderType,
  monitorId?: string,
  loaders: SystemPromptLoaders = DEFAULT_LOADERS,
): Promise<string> {
  const scopedPrompt = basePrompt + buildScopeSection(role, monitorId);

  if (isAppRole(role)) {
    return scopedPrompt;
  }

  const environment = await loaders.buildEnvironment(providerType);
  return scopedPrompt + providerSection(providerType) + environment;
}
