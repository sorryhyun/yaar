/**
 * Model capability tiers — the mapping between an app's declared `agentType`,
 * the Claude model id it runs on, and the Codex equivalent.
 *
 * A leaf module, not part of `profiles/index.ts`: the barrel pulls in every
 * profile and, through them, the MCP and handler graph. Tier resolution is a
 * pure lookup that `app-agent.ts` and callers should be able to reach without
 * that weight.
 */

import { isFableMode } from '../../config/env.js';

/** Map short agentType names to full model identifiers. */
export const AGENT_TYPE_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

/** The monitor agent's model in fable mode (`FABLE=1`). */
export const FABLE_MODEL = 'claude-fable-5-1';

/**
 * The model an agent below the monitor runs on. Identity outside fable mode; inside
 * it, every such agent is pinned to Opus — whatever its app declared, including an
 * explicit sub-agent `model` override.
 */
export function subordinateModel(model: string | undefined): string | undefined {
  return isFableMode() ? AGENT_TYPE_MODELS.opus : model;
}

/** Resolve an app's `agentType` to the model its agent runs on. */
export function resolveAgentModel(agentType?: string): string | undefined {
  // App agents default to the Sonnet capability tier. Keep that default explicit
  // so Codex can translate it to Terra explicitly instead of omitting `model`
  // from thread/start and inheriting the shared app-server default.
  if (!agentType) return subordinateModel(AGENT_TYPE_MODELS.sonnet);
  return subordinateModel(AGENT_TYPE_MODELS[agentType] ?? agentType); // allow full model ID as fallback
}

/**
 * Map Claude capability tiers to their Codex equivalents. Fable is its own tier on both
 * sides: only fable mode's monitor agent names it, so under Codex that monitor runs on
 * Astra while the Opus-pinned agents below it run on Sol.
 */
export function claudeModelToCodex(model?: string): string | undefined {
  if (!model) return undefined;
  if (model.includes('fable')) return 'gpt-6-astra';
  if (model.includes('opus')) return 'gpt-5.6-sol';
  if (model.includes('sonnet')) return 'gpt-5.6-terra';
  return undefined;
}
