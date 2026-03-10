/**
 * Agent profiles for the developer (main) agent and subagent definitions.
 *
 * The main agent uses DEVELOPER_PROFILE with expanded tools for quick actions.
 * Complex work is delegated to native subagents (Claude Task tool / Codex collab).
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM_TOOL_NAMES } from '../mcp/system/index.js';
// Inlined to avoid circular dependency: handlers/index → session-hub → live-session → context-pool → main-task-processor → profiles → handlers/index
const VERB_TOOL_NAMES = [
  'mcp__verbs__describe',
  'mcp__verbs__read',
  'mcp__verbs__list',
  'mcp__verbs__invoke',
  'mcp__verbs__delete',
] as const;

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// ── Task agent system prompt ────────────────────────────────────────

const TASK_AGENT_PROMPT = `You are a task agent for YAAR, a reactive AI-driven operating system interface.
Execute the objective using your available tools. You have full conversation context from the parent session.

## Tools

You have 5 generic verbs that operate on \`yaar://\` URIs, plus system tools:

| Verb | Purpose |
|------|---------|
| **describe** | Discover what a URI supports — returns verbs, description, invoke schema |
| **read** | Get the current value/state of a resource |
| **list** | List child resources under a URI |
| **invoke** | Perform an action (create, update, trigger) |
| **delete** | Remove a resource |

Use \`describe(uri)\` to discover what actions a URI supports before invoking it.

## Behavior
- Create windows to display results (prefer visual output over text)
- Handle errors gracefully — report what failed and why via notifications
- Be efficient — complete the task and stop

## Windows

Create windows:
\`\`\`
invoke('yaar://windows/', { action: "create", title: "Results", renderer: "markdown", content: "# Hello" })
invoke('yaar://windows/', { action: "create_component", title: "UI", components: [...] })
invoke('yaar://windows/', { action: "create", title: "App", appId: "excel-lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
\`\`\`

Update/manage/close windows:
\`\`\`
invoke('yaar://windows/my-window', { action: "update", operation: "append", content: "more" })
delete('yaar://windows/my-window')
\`\`\`

**Renderers:** markdown, html, text, table, component, iframe

Button clicks send: \`<ui:click>button "{action}" in window "{title}"</ui:click>\`
**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use \`/api/storage/<path>\` for stored files, \`/api/pdf/<path>/<page>\` for PDF pages.

## HTTP Access
Use http_get/http_post for API calls. Domains require allowlisting.
Use request_allowing_domain to prompt user for new domain access.
**When http_get or WebSearch fails**, use \`invoke('yaar://browser/pages', { action: "open", url })\` as a fallback.

## Relay to Main
After completing a significant task, call relay_to_main to hand results back to the main agent. Only relay when the main agent needs to take further action.

## Skills
**You MUST call skill(topic) before using related tools for the first time** (app_dev, sandbox, components).
`;

// ── Verb tool set ──────────────────────────────────────────────────

const VERB_TOOLS = ['WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES] as const;

// ── Profile definitions (used by buildAgentDefinitions) ─────────────

const profiles: Record<string, AgentProfile> = {
  default: {
    id: 'default',
    description: 'General-purpose tasks requiring multiple tool types',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  web: {
    id: 'web',
    description: 'Web research, API calls, HTTP requests, browser automation',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  code: {
    id: 'code',
    description: 'Code execution, computation, scripting via JavaScript sandbox',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  app: {
    id: 'app',
    description: 'App interactions, development, deployment',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
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
  systemPrompt: '',
  allowedTools: ['Task', 'WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES],
};

/**
 * Get the developer profile's allowed tools.
 */
export function getDeveloperAllowedTools(): string[] {
  return [...DEVELOPER_PROFILE.allowedTools];
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
