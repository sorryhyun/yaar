/**
 * Make the hosted Remote Control session a YAAR monitor agent rather than a stock
 * Claude Code.
 *
 * `claude remote-control` takes no `--mcp-config`, `--system-prompt` or `--tools`, but
 * the sessions it spawns read their working directory and inherit its environment. So
 * the monitor agent's options are built by the same `buildSDKOptions` a real monitor
 * turn goes through, and each field is written where a plain CLI will find it:
 *
 * | SDK option     | Remote Control session                                          |
 * |----------------|-----------------------------------------------------------------|
 * | `env`          | the spawn env of `remote-control` (children inherit it)         |
 * | `mcpServers`   | `<cwd>/.mcp.json`, header values as `${VAR}` refs into that env |
 * | `systemPrompt` | `<cwd>/.claude/output-styles/yaar.md`, coding instructions off  |
 * | `allowedTools` | `permissions.allow` in `<cwd>/.claude/settings.json`            |
 * | `tools`        | `permissions.deny` for every built-in the SDK set leaves out    |
 * | `model`        | `model` in the same settings                                    |
 *
 * Two things are deliberately not the local monitor's. The prompt is the remote variant
 * (`getRemoteOrchestratorPrompt`): the user reads the chat on claude.ai, and the per-turn
 * context the local monitor is fed — timeline, reload options, relays — never arrives,
 * so the reload tools that only serve that context are dropped from the tool set too.
 * And the CLI defers MCP tools behind ToolSearch where the SDK path loads them up front,
 * so the env turns that off (`ENABLE_TOOL_SEARCH=false`, an explicit opt-out that also
 * beats the service-side force flag).
 *
 * Header values never touch disk: the bearer and the agent token are secrets, so the
 * file names env vars and the spawn env carries the values.
 *
 * The directory is generated into `config/remote-control/` (git-ignored with the rest
 * of `config/`) and rewritten on every start, so it cannot drift from the options.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../../config.js';

/** The agent id the hosted session's MCP token is minted for. */
export const REMOTE_AGENT_ID = 'remote-control';

const OUTPUT_STYLE = 'yaar';

/**
 * Claude Code built-ins a YAAR monitor agent does not have. The SDK expresses this as
 * an allowlist (`tools`); settings can only deny, so the complement is spelled out.
 * A name the running CLI does not know is an inert rule.
 */
const CLI_BUILTIN_TOOLS = [
  'Agent',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'FetchInboxMessage',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'REPL',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

/**
 * Env the remote session needs on top of the monitor agent's. The SDK path gets MCP
 * tools loaded up front; the CLI defers them behind ToolSearch unless told not to, which
 * cost the first remote turn a round trip just to load YAAR's own verbs.
 */
const REMOTE_ENV_OVERRIDES = {
  ENABLE_TOOL_SEARCH: 'false',
} as const;

export interface RemoteAgentConfig {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Build the monitor agent's SDK options for `monitorId` and write them out. Mints the
 * {@link REMOTE_AGENT_ID} token as a side effect.
 *
 * Imports are dynamic because this module is reached from the verb registry, and the
 * profile/provider graph it needs already reaches back into the registry at import time.
 */
export async function writeRemoteAgentConfig(monitorId: string): Promise<RemoteAgentConfig> {
  const [
    { buildSDKOptions },
    { getRemoteOrchestratorPrompt },
    { getMonitorTurnOptions },
    sp,
    roles,
    { buildEnvironmentSection },
    { SYSTEM_TOOL_NAMES },
  ] = await Promise.all([
    import('../../providers/claude/sdk-options.js'),
    import('../../agents/profiles/orchestrator/index.js'),
    import('../../agents/profiles/turn-options.js'),
    import('../../agents/system-prompt.js'),
    import('../../agents/roles.js'),
    import('../../providers/environment.js'),
    import('../../mcp/system/tool-names.js'),
  ]);

  const turn = getMonitorTurnOptions('claude');
  const systemPrompt = await sp.assembleSystemPromptForRole(
    getRemoteOrchestratorPrompt(),
    roles.monitorRole(monitorId),
    'claude',
    monitorId,
    // Onboarding waits for a desktop click that never reaches a remote session.
    { buildEnvironment: (provider) => buildEnvironmentSection(provider, { onboarding: false }) },
  );
  // reload_cached / list_reload_options replay `<reload_options>`, which only a local
  // monitor turn is given.
  const reloadTools = new Set<string>(SYSTEM_TOOL_NAMES);
  const allowedTools = turn.allowedTools?.filter((t) => !reloadTools.has(t));
  const options = buildSDKOptions({
    options: {
      systemPrompt,
      model: turn.model,
      allowedTools,
      monitorId,
      agentId: REMOTE_AGENT_ID,
    },
    defaultSystemPrompt: systemPrompt,
    abortController: new AbortController(),
    onEscapeGuard: () => {},
  });

  // `agentId` makes buildSDKOptions mint this principal's token into the MCP headers,
  // exactly as for a pooled agent. Revoking it is the host's job when the process exits.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }
  Object.assign(env, REMOTE_ENV_OVERRIDES);

  const secretVars = new Map<string, string>(); // header value → env var name
  const envRef = (value: string): string => {
    let name = secretVars.get(value);
    if (!name) {
      name = `YAAR_MCP_HEADER_${secretVars.size}`;
      secretVars.set(value, name);
      env[name] = value;
    }
    return `\${${name}}`;
  };

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    if (!('url' in server)) continue;
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(server.headers ?? {})) headers[h] = envRef(v);
    mcpServers[name] = { type: server.type, url: server.url, headers };
  }

  const tools = new Set(Array.isArray(options.tools) ? options.tools : []);
  const settings = {
    enableAllProjectMcpServers: true,
    outputStyle: OUTPUT_STYLE,
    ...(options.model ? { model: options.model } : {}),
    permissions: {
      allow: options.allowedTools ?? [],
      deny: [
        ...CLI_BUILTIN_TOOLS.filter((t) => !tools.has(t)),
        ...(options.disallowedTools ?? []),
      ].filter((t, i, all) => all.indexOf(t) === i),
    },
  };

  const outputStyle =
    '---\n' +
    `name: ${OUTPUT_STYLE}\n` +
    'description: YAAR monitor agent\n' +
    'keep-coding-instructions: false\n' +
    '---\n\n' +
    (typeof options.systemPrompt === 'string' ? options.systemPrompt : systemPrompt) +
    '\n';

  const cwd = join(getConfigDir(), 'remote-control');
  mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true });
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'output-styles', `${OUTPUT_STYLE}.md`), outputStyle);

  return { cwd, env };
}
