/**
 * Agent profiles barrel — single import point for all profile consumers.
 *
 * Re-exports profile definitions, builder functions, and Codex role config.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from './types.js';
import { VERB_TOOL_NAMES } from './types.js';
import { SYSTEM_TOOL_NAMES } from '../../mcp/system/index.js';
import { DEFAULT_PROFILE } from './default.js';
import { WEB_PROFILE } from './web.js';
// Re-export types and constants
export type { AgentProfile } from './types.js';
export { VERB_TOOL_NAMES, VERB_TOOLS, APP_AGENT_TOOL_NAMES } from './types.js';

// App agent profile builder
export { buildAppAgentProfile } from './app-agent.js';

// Re-export individual profiles
export { DEFAULT_PROFILE } from './default.js';
export { WEB_PROFILE } from './web.js';

// Re-export orchestrator
export { ORCHESTRATOR_PROMPT, getOrchestratorPrompt } from './orchestrator.js';

// Re-export session agent profile
export { SESSION_AGENT_PROFILE } from './session-agent.js';

// ── Profile registry ──────────────────────────────────────────────────

const profiles: Record<string, AgentProfile> = {
  default: DEFAULT_PROFILE,
  web: WEB_PROFILE,
};

/**
 * Get a profile by ID. Returns the 'default' profile for unknown IDs.
 */
export function getProfile(id: string): AgentProfile {
  return profiles[id] ?? profiles.default;
}

// ── Developer profile (monitor agent) ────────────────────────────────

/**
 * Developer profile — applied to the monitor agent.
 * Can handle quick actions directly and delegates complex work via Task tool.
 */
export const DEVELOPER_PROFILE: AgentProfile = {
  id: 'developer',
  description: 'Developer agent — handles quick actions directly, delegates complex work',
  systemPrompt: '',
  allowedTools: ['Task', 'WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES],
};

/**
 * Get the developer profile's allowed tools.
 */
export function getDeveloperAllowedTools(): string[] {
  return [...DEVELOPER_PROFILE.allowedTools];
}

// ── Claude SDK agent definitions ─────────────────────────────────────

/** Extract MCP server names from tool names (mcp__<server>__<tool> → server). */
function extractMcpServerNames(tools: string[]): string[] {
  const servers = new Set<string>();
  for (const tool of tools) {
    const m = tool.match(/^mcp__(\w+)__/);
    if (m) servers.add(m[1]);
  }
  return [...servers];
}

/** MCP HTTP server config shape (matches SDK's McpHttpServerConfig). */
interface McpHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Build Claude SDK AgentDefinition records for native subagents.
 * Each definition maps to a profile with a specific tool subset.
 * mcpServers must be explicitly provided — subagents don't inherit parent MCP servers.
 */
export function buildAgentDefinitions(
  mcpServerConfigs?: Record<string, McpHttpConfig>,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(profiles).map(([id, profile]) => {
      const tools = [...profile.allowedTools];
      const neededServers = extractMcpServerNames(tools);

      // Build mcpServers: single Record mapping server name → HTTP config
      let mcpServers: AgentDefinition['mcpServers'];
      if (mcpServerConfigs && neededServers.length > 0) {
        const serverRecord: Record<string, McpHttpConfig> = {};
        for (const name of neededServers) {
          if (mcpServerConfigs[name]) serverRecord[name] = mcpServerConfigs[name];
        }
        if (Object.keys(serverRecord).length > 0) {
          mcpServers = [serverRecord];
        }
      }

      return [
        id,
        {
          description: profile.description,
          prompt: profile.systemPrompt,
          tools,
          disallowedTools: ['Task'],
          mcpServers,
        } satisfies AgentDefinition,
      ];
    }),
  );
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
  default: {
    description: 'General-purpose helper',
  },
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
