/**
 * Agent profiles for the developer (main) agent and subagent definitions.
 *
 * The main agent uses DEVELOPER_PROFILE with expanded tools for quick actions.
 * Complex work is delegated to native subagents (Claude Task tool / Codex collab).
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
/** @deprecated Legacy tool name imports — used only for normal (non-verb) mode. */
import { WINDOW_TOOL_NAMES } from '../mcp/legacy/window/index.js';
import { HTTP_TOOL_NAMES } from '../mcp/http/index.js';
/** @deprecated */ import { APPS_TOOL_NAMES } from '../mcp/legacy/apps/index.js';
/** @deprecated */ import { DEV_TOOL_NAMES } from '../mcp/legacy/dev/index.js';
/** @deprecated */ import { BASIC_TOOL_NAMES } from '../mcp/legacy/basic/index.js';
import { SKILL_TOOL_NAMES } from '../mcp/skills/names.js';
import { RELOAD_TOOL_NAMES } from '../reload/tools.js';
/** @deprecated */ import { CONFIG_TOOL_NAMES } from '../mcp/legacy/config/index.js';
import { BROWSER_TOOL_NAMES } from '../mcp/legacy/browser/index.js';
import { isBrowserAvailable } from '../features/browser/availability.js';
import { VERB_TOOL_NAMES } from '../mcp/verbs/index.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// ── Composite tool sets (for profile readability) ─────────────────

const INFO_TOOLS = ['mcp__system__get_info', ...SKILL_TOOL_NAMES] as const;
const NOTIFICATION_TOOL = 'mcp__system__show_notification';
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
- **iframe**: Apps via \`yaar://apps/appId\`, or external websites

Button clicks send: \`<ui:click>button "{action}" in window "{title}"</ui:click>\`

**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use \`/api/storage/<path>\` for stored files, \`/api/pdf/<path>/<page>\` for PDF pages.

## HTTP Access
Use http_get/http_post for API calls. Domains require allowlisting.
Use request_allowing_domain to prompt user for new domain access.
**When http_get or WebSearch fails** (blocked domain, timeout, access denied), use browser:open as a fallback to load the page directly. The browser tool works with any URL without domain restrictions.

## Relay to Main
After completing a significant task (form submission, data retrieval, workflow step), call relay_to_main to hand results back to the main agent. Only relay when the main agent needs to take further action — not for simple acknowledgments.

## Skills
**You MUST call skill(topic) before using related tools for the first time** (app_dev, sandbox, components).
`;

const VERB_TASK_AGENT_PROMPT = `You are a task agent for YAAR, a reactive AI-driven operating system interface.
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

// ── Verb-mode tool set (replaces all domain tools with 5 verbs) ────

const VERB_TOOLS = [
  'WebSearch',
  NOTIFICATION_TOOL,
  ...INFO_TOOLS,
  ...HTTP_TOOL_NAMES,
  'mcp__system__run_js',
  ...RELOAD_TOOL_NAMES,
  ...VERB_TOOL_NAMES,
] as const;

// ── Profile definitions (used by buildAgentDefinitions) ─────────────

/** @deprecated Legacy profiles for normal (non-verb) mode. Use verb mode profiles instead. */
const legacyProfiles: Record<string, AgentProfile> = {
  default: {
    id: 'default',
    description: 'General-purpose tasks requiring multiple tool types',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      NOTIFICATION_TOOL,
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      'mcp__system__run_js',
      ...BROWSER_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...BASIC_TOOL_NAMES,
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
      NOTIFICATION_TOOL,
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...BROWSER_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...BASIC_TOOL_NAMES,
    ],
  },

  code: {
    id: 'code',
    description: 'Code execution, computation, scripting via JavaScript sandbox',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      NOTIFICATION_TOOL,
      ...INFO_TOOLS,
      'mcp__system__run_js',
      ...WINDOW_TOOL_NAMES,
      ...BASIC_TOOL_NAMES,
    ],
  },

  app: {
    id: 'app',
    description: 'App interactions, development, deployment',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      NOTIFICATION_TOOL,
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...APPS_ALL_TOOLS,
      ...WINDOW_TOOL_NAMES,
      ...BASIC_TOOL_NAMES,
      ...DEV_TOOL_NAMES,
    ],
  },
};

/** Verb-mode profiles (default) — all profiles use the same verb tool set. */
const profiles: Record<string, AgentProfile> = {
  default: {
    id: 'default',
    description: 'General-purpose tasks requiring multiple tool types',
    systemPrompt: VERB_TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  web: {
    id: 'web',
    description: 'Web research, API calls, HTTP requests, browser automation',
    systemPrompt: VERB_TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  code: {
    id: 'code',
    description: 'Code execution, computation, scripting via JavaScript sandbox',
    systemPrompt: VERB_TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
  app: {
    id: 'app',
    description: 'App interactions, development, deployment',
    systemPrompt: VERB_TASK_AGENT_PROMPT,
    allowedTools: [...VERB_TOOLS],
  },
};

/**
 * Get a profile by ID. Returns the 'default' profile for unknown IDs.
 * In verb mode, returns verb-specific profiles with verb tools and prompt.
 */
export function getProfile(id: string, verbMode?: boolean): AgentProfile {
  if (verbMode === false) {
    console.warn('[Profiles] Legacy tool mode is deprecated. Consider switching to verb mode.');
    return legacyProfiles[id] ?? legacyProfiles.default;
  }
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
    NOTIFICATION_TOOL,
    ...INFO_TOOLS,
    ...HTTP_TOOL_NAMES,
    'mcp__system__run_js',
    ...BROWSER_TOOL_NAMES,
    ...WINDOW_TOOL_NAMES,
    ...BASIC_TOOL_NAMES,
    ...APPS_ALL_TOOLS,
    ...RELOAD_TOOL_NAMES,
    ...DEV_TOOL_NAMES,
    // System tools
    'mcp__system__memorize',
    'mcp__system__get_env_var',
    ...CONFIG_TOOL_NAMES,
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
 * In verb mode, uses verb-specific profiles with verb tools and prompt.
 */
export function buildAgentDefinitions(
  mcpServerConfigs?: Record<string, McpHttpConfig>,
  verbMode?: boolean,
): Record<string, AgentDefinition> {
  const source = verbMode === false ? legacyProfiles : profiles;
  return Object.fromEntries(
    Object.entries(source).map(([id, profile]) => {
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
