/**
 * Agent profiles for orchestrator and task agents.
 *
 * Each profile defines a tool subset and system prompt for a specific agent role.
 * The orchestrator dispatches tasks to specialized agents via `dispatch_task`.
 */

import { WINDOW_TOOL_NAMES } from '../mcp/window/index.js';
import { STORAGE_TOOL_NAMES } from '../mcp/storage/index.js';
import { HTTP_TOOL_NAMES } from '../mcp/http/index.js';
import { APPS_TOOL_NAMES } from '../mcp/apps/index.js';
import { MARKET_TOOL_NAMES } from '../mcp/apps/market.js';
import { DEV_TOOL_NAMES } from '../mcp/dev/index.js';
import { GUIDELINE_TOOL_NAMES } from '../mcp/guidelines/index.js';
import { SANDBOX_TOOL_NAMES } from '../mcp/sandbox/index.js';
import { RELOAD_TOOL_NAMES } from '../reload/tools.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// ── Composite tool sets (for profile readability) ─────────────────

const INFO_TOOLS = ['mcp__system__get_info', ...GUIDELINE_TOOL_NAMES] as const;
const APPS_ALL_TOOLS = [...APPS_TOOL_NAMES, ...MARKET_TOOL_NAMES] as const;

// ── Task agent system prompt ────────────────────────────────────────

const TASK_AGENT_PROMPT = `You are a task agent for YAAR, a reactive AI-driven operating system interface.
Execute the objective using your available tools. You have full conversation context from a session fork.

## Behavior
- Create windows to display results (prefer visual output over text)
- Use appropriate renderers: markdown for text, component for interactive UI, iframe for web content
- Handle errors gracefully — report what failed and why via notifications
- Be efficient — complete the task and stop

## Content Rendering
- **component**: Interactive UI with buttons, forms, layouts
- **markdown**: Documentation, explanations, formatted text
- **iframe**: External websites, compiled apps

Button clicks send: \`<user_interaction:click>button "{action}" in window "{title}"</user_interaction:click>\`

**Forms:** Use type: "form" with an id. Buttons with submitForm collect form data on click.
**Images:** Use \`/api/storage/<path>\` for stored files, \`/api/pdf/<path>/<page>\` for PDF pages.

## HTTP Access
Use http_get/http_post for API calls. Domains require allowlisting.
Use request_allowing_domain to prompt user for new domain access.

## Guidelines
Use guideline(topic) to load reference docs for unfamiliar tasks.
`;

// ── Profile definitions ─────────────────────────────────────────────

const profiles: Record<string, AgentProfile> = {
  default: {
    id: 'default',
    description: 'Full execution tools (all except orchestrator-only)',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...SANDBOX_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
      ...APPS_ALL_TOOLS,
      ...RELOAD_TOOL_NAMES,
      ...DEV_TOOL_NAMES,
    ],
  },

  web: {
    id: 'web',
    description: 'HTTP requests + display (API calls, web scraping)',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
    ],
  },

  code: {
    id: 'code',
    description: 'JavaScript sandbox + display',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      ...INFO_TOOLS,
      ...SANDBOX_TOOL_NAMES,
      ...WINDOW_TOOL_NAMES,
      ...STORAGE_TOOL_NAMES,
    ],
  },

  app: {
    id: 'app',
    description: 'App skills + HTTP + display',
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
 * Orchestrator profile — applied to the main agent.
 * Only has dispatch + lightweight management tools.
 */
export const ORCHESTRATOR_PROFILE: AgentProfile = {
  id: 'orchestrator',
  description: 'Intent interpretation + task dispatch',
  systemPrompt: '', // Uses the main system prompt
  allowedTools: [
    // Dispatch
    'mcp__system__dispatch_task',
    // Window management (read + close only)
    'mcp__window__list',
    'mcp__window__view',
    'mcp__window__close',
    // Notifications
    'mcp__window__show_notification',
    'mcp__window__dismiss_notification',
    // Memory + info
    'mcp__system__memorize',
    ...GUIDELINE_TOOL_NAMES,
    'mcp__system__get_info',
    'mcp__system__get_env_var',
    // Cache replay
    ...RELOAD_TOOL_NAMES,
    // Config hooks
    'mcp__system__set_config',
    'mcp__system__get_config',
    'mcp__system__remove_config',
  ],
};
