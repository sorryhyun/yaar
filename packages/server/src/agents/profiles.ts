/**
 * Agent profiles for the developer (main) agent and subagent definitions.
 *
 * The main agent uses DEVELOPER_PROFILE with expanded tools for quick actions.
 * Complex work is delegated to native subagents (Claude Task tool / Codex collab).
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { WINDOW_TOOL_NAMES } from '../mcp/window/index.js';
import { STORAGE_TOOL_NAMES } from '../mcp/storage/index.js';
import { HTTP_TOOL_NAMES } from '../mcp/http/index.js';
import { APPS_TOOL_NAMES } from '../mcp/apps/index.js';
import { DEV_TOOL_NAMES } from '../mcp/dev/index.js';
import { SKILL_TOOL_NAMES } from '../mcp/skills/names.js';
import { RELOAD_TOOL_NAMES } from '../reload/tools.js';
import { BROWSER_TOOL_NAMES, isBrowserAvailable } from '../mcp/browser/index.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// ── Composite tool sets (for profile readability) ─────────────────

const INFO_TOOLS = ['mcp__system__get_info', ...SKILL_TOOL_NAMES] as const;
const APPS_ALL_TOOLS = APPS_TOOL_NAMES;

// ── Task agent system prompt ────────────────────────────────────────

const TASK_AGENT_PROMPT = `You are a task agent for YAAR, a reactive AI-driven operating system interface.
Execute the objective using your available tools. You have full conversation context from the parent session.

## Behavior
- Create windows to display results (prefer visual output over text)
- Use appropriate renderers: markdown for text, component for interactive UI, iframe for web content
- Handle errors gracefully — report what failed and why via notifications
- Be efficient — complete the task and stop

## Content Rendering
- **component**: Interactive UI with buttons, forms, layouts
- **markdown**: Documentation, explanations, formatted text
- **iframe**: Compiled apps via \`app://appId\`, or external websites

Button clicks send: \`<ui:click>button "{action}" in window "{title}"</ui:click>\`

**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use \`/api/storage/<path>\` for stored files, \`/api/pdf/<path>/<page>\` for PDF pages.

## HTTP Access
Use http_get/http_post for API calls. Domains require allowlisting.
Use request_allowing_domain to prompt user for new domain access.

## Relay to Main
After completing a significant task (form submission, data retrieval, workflow step), call relay_to_main to hand results back to the main agent. Only relay when the main agent needs to take further action — not for simple acknowledgments.

## Skills
**You MUST call skill(topic) before using related tools for the first time** (app_dev, sandbox, components).
`;

// ── Profile definitions (used by buildAgentDefinitions) ─────────────

const profiles: Record<string, AgentProfile> = {
  default: {
    id: 'default',
    description: 'General-purpose tasks requiring multiple tool types',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      'mcp__system__run_js',
      ...BROWSER_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
      ...APPS_ALL_TOOLS,
      ...RELOAD_TOOL_NAMES,
      ...DEV_TOOL_NAMES,
    ],
  },

  web: {
    id: 'web',
    description: 'Web research, API calls, HTTP requests, browser automation',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...BROWSER_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
    ],
  },

  code: {
    id: 'code',
    description: 'Code execution, computation, scripting via JavaScript sandbox',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      ...INFO_TOOLS,
      'mcp__system__run_js',
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
    ],
  },

  app: {
    id: 'app',
    description: 'App interactions, development, deployment',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...APPS_ALL_TOOLS,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
      ...DEV_TOOL_NAMES,
    ],
  },
};

/**
 * Get a profile by ID. Returns the 'default' profile for unknown IDs.
 */
export function getProfile(id: string): AgentProfile {
  return profiles[id] ?? profiles.default;
}

/**
 * Developer profile — applied to the main agent.
 * Can handle quick actions directly and delegates complex work via Task tool.
 */
export const DEVELOPER_PROFILE: AgentProfile = {
  id: 'developer',
  description: 'Developer agent — handles quick actions directly, delegates complex work',
  systemPrompt: '', // Uses the main system prompt
  allowedTools: [
    // Native subagent spawner (Claude SDK Task tool)
    'Task',
    'WebSearch',
    ...INFO_TOOLS,
    ...HTTP_TOOL_NAMES,
    'mcp__system__run_js',
    ...BROWSER_TOOL_NAMES,
    ...WINDOW_TOOL_NAMES,
    ...STORAGE_TOOL_NAMES,
    ...APPS_ALL_TOOLS,
    ...RELOAD_TOOL_NAMES,
    ...DEV_TOOL_NAMES,
    // System tools
    'mcp__system__memorize',
    'mcp__system__get_env_var',
    'mcp__system__set_config',
    'mcp__system__get_config',
    'mcp__system__remove_config',
  ],
};

/** Filter out browser tool names when Chrome/Edge is not available. */
const BROWSER_SET = new Set<string>(BROWSER_TOOL_NAMES);
function filterAvailableTools(tools: readonly string[]): string[] {
  if (isBrowserAvailable()) return [...tools];
  return tools.filter((t) => !BROWSER_SET.has(t));
}

/** Extract MCP server names from tool names (mcp__<server>__<tool> → server). */
function extractMcpServerNames(tools: string[]): string[] {
  const servers = new Set<string>();
  for (const tool of tools) {
    const m = tool.match(/^mcp__(\w+)__/);
    if (m) servers.add(m[1]);
  }
  return [...servers];
}

/**
 * Get the developer profile's allowed tools, filtered by runtime availability.
 */
export function getDeveloperAllowedTools(): string[] {
  return filterAvailableTools(DEVELOPER_PROFILE.allowedTools);
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
      const tools = filterAvailableTools(profile.allowedTools);
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

// ── Codex agent roles (subagent config for codex app-server) ──────────

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
  if (model) lines.push(`model = "${model}"`);
  if (role.modelReasoningEffort)
    lines.push(`model_reasoning_effort = "${role.modelReasoningEffort}"`);
  if (role.sandboxMode) lines.push(`sandbox_mode = "${role.sandboxMode}"`);
  if (role.instructions) lines.push(`developer_instructions = "${role.instructions}"`);
  return lines.join('\n') + '\n';
}
