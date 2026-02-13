/**
 * Agent profiles for orchestrator and task agents.
 *
 * Each profile defines a tool subset and system prompt for a specific agent role.
 * The orchestrator dispatches tasks to specialized agents via `dispatch_task`.
 */

import { APP_DEV_ENABLED } from '../config.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// ── Shared tool sets ────────────────────────────────────────────────

const WINDOW_TOOLS = [
  'mcp__window__create',
  'mcp__window__create_component',
  'mcp__window__update',
  'mcp__window__update_component',
  'mcp__window__close',
  'mcp__window__lock',
  'mcp__window__unlock',
  'mcp__window__list',
  'mcp__window__view',
  'mcp__window__show_notification',
  'mcp__window__dismiss_notification',
  'mcp__window__app_query',
  'mcp__window__app_command',
];

const STORAGE_TOOLS = [
  'mcp__storage__read',
  'mcp__storage__write',
  'mcp__storage__list',
  'mcp__storage__delete',
];

const HTTP_TOOLS = [
  'mcp__system__http_get',
  'mcp__system__http_post',
  'mcp__system__request_allowing_domain',
];

const APPS_TOOLS = [
  'mcp__apps__list',
  'mcp__apps__load_skill',
  'mcp__apps__read_config',
  'mcp__apps__write_config',
  'mcp__apps__market_list',
  'mcp__apps__market_get',
];

const DEV_TOOLS = [
  'mcp__dev__read_ts',
  'mcp__dev__write_ts',
  'mcp__dev__apply_diff_ts',
  'mcp__dev__compile',
  'mcp__dev__compile_component',
  'mcp__dev__typecheck',
  'mcp__dev__deploy',
  'mcp__dev__clone',
  'mcp__dev__write_json',
];

const INFO_TOOLS = ['mcp__system__get_info', 'mcp__system__guideline'];

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

## Storage
You have persistent storage for user data, notes, and files across sessions.

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
      ...HTTP_TOOLS,
      'mcp__system__run_js',
      ...WINDOW_TOOLS,
      ...STORAGE_TOOLS,
      ...APPS_TOOLS,
      'mcp__system__reload_cached',
      'mcp__system__list_reload_options',
      ...(APP_DEV_ENABLED ? DEV_TOOLS : []),
    ],
  },

  web: {
    id: 'web',
    description: 'HTTP requests + display (API calls, web scraping)',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: ['WebSearch', ...INFO_TOOLS, ...HTTP_TOOLS, ...WINDOW_TOOLS, ...STORAGE_TOOLS],
  },

  code: {
    id: 'code',
    description: 'JavaScript sandbox + display',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [...INFO_TOOLS, 'mcp__system__run_js', ...WINDOW_TOOLS, ...STORAGE_TOOLS],
  },

  app: {
    id: 'app',
    description: 'App skills + HTTP + display',
    systemPrompt: TASK_AGENT_PROMPT,
    allowedTools: [
      'WebSearch',
      ...INFO_TOOLS,
      ...HTTP_TOOLS,
      ...APPS_TOOLS,
      ...WINDOW_TOOLS,
      ...STORAGE_TOOLS,
      ...(APP_DEV_ENABLED ? DEV_TOOLS : []),
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
    'mcp__system__guideline',
    'mcp__system__get_info',
    'mcp__system__get_env_var',
    // Cache replay
    'mcp__system__reload_cached',
    'mcp__system__list_reload_options',
    // Config hooks
    'mcp__system__set_config',
    'mcp__system__get_config',
    'mcp__system__remove_config',
  ],
};
// test
